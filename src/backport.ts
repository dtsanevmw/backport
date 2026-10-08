import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { group, info, error as logError, warning } from "@actions/core";
import { getOctokit } from "@actions/github";
import type {
  PullRequestClosedEvent,
  PullRequestLabeledEvent,
} from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { compact } from "lodash-es";
import {
  getConflictsNotice,
  getFailureCommentBody,
  getSuccessCommentBody,
  upsertStatusComment,
} from "./comments.js";
import type { Git } from "./git.js";
import { createGit, getConflictedFiles } from "./git.js";
import type { Github } from "./github.js";

type ConflictResolution = "draft" | "fail";

type Target = Readonly<{ base: string; label: string }>;

// A conservative subset of what `git check-ref-format --branch` accepts.
// It keeps option-looking values out of git's arguments and shell metacharacters out of the manual backport instructions.
const isSafeBranchName = (name: string): boolean =>
  /^[\w.+@=/-]+$/.test(name) &&
  !name.startsWith("-") &&
  !name.startsWith("/") &&
  !name.endsWith("/") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock") &&
  !name.includes("..") &&
  !name.includes("//") &&
  !name.includes("@{");

const assertSafeBranchName = (name: string, origin: string) => {
  if (!isSafeBranchName(name)) {
    throw new Error(
      `Refusing to use unsafe branch name "${name}" (${origin}).`,
    );
  }
};

const getTargetFromLabel = (
  label: string,
  labelRegExp: RegExp,
): Target | undefined => {
  const result = labelRegExp.exec(label);

  if (!result || !result.groups) {
    return;
  }

  const { base } = result.groups;

  if (!base) {
    throw new Error(
      `RegExp "${String(
        labelRegExp,
      )}" matched "${label}" but missed a "base" named capturing group.`,
    );
  }

  assertSafeBranchName(base, `from label "${label}"`);

  return { base, label };
};

const getTargets = ({
  labelRegExp,
  payload,
}: Readonly<{
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
}>): Target[] => {
  if ("label" in payload) {
    const target = getTargetFromLabel(payload.label.name, labelRegExp);
    return target ? [target] : [];
  }

  return compact(
    payload.pull_request.labels.map((label) =>
      getTargetFromLabel(label.name, labelRegExp),
    ),
  );
};

const isBot = (login: string) => login.endsWith("[bot]");

// GitHub rejects review requests for bots, so they are left out.
const getReviewers = ({
  author,
  mergedBy,
}: Readonly<{ author: string; mergedBy: string }>): string[] =>
  [...new Set([author, mergedBy])].filter(
    (login) => login !== "" && !isBot(login),
  );

// The backport PR already exists at this point so failing to decorate it must not be reported as a failed backport.
const bestEffort = async (description: string, run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (_error: unknown) {
    warning(`Could not ${description}: ${ensureError(_error).message}`);
  }
};

/**
 * Picks what to cherry-pick depending on how the PR was merged:
 * - merge commit: the merge commit against its first parent, which brings all the PR's changes at once.
 * - rebase and merge: every rebased commit, recognized by their messages matching the PR's commits.
 * - squash and merge: the single squashed commit.
 */
const getCherryPickArgs = ({
  mergeCommitSha,
  mergedMessages,
  parentCount,
  pullRequestMessages,
}: Readonly<{
  mergeCommitSha: string;
  // Messages of the commits ending at the merge commit, oldest first.
  mergedMessages: readonly string[];
  parentCount: number;
  // Messages of the PR's commits, oldest first.
  pullRequestMessages: readonly string[];
}>): string[] => {
  if (parentCount > 1) {
    return ["--mainline", "1", mergeCommitSha];
  }

  const commitCount = pullRequestMessages.length;
  const isRebased =
    commitCount > 1 &&
    mergedMessages.length === commitCount &&
    mergedMessages.every(
      (message, index) => message.trim() === pullRequestMessages[index]?.trim(),
    );

  return isRebased
    ? [`${mergeCommitSha}~${commitCount}..${mergeCommitSha}`]
    : [mergeCommitSha];
};

const resolveCherryPickArgs = async ({
  commitCount,
  git,
  github,
  mergeCommitSha,
  number,
  owner,
  repo,
}: Readonly<{
  commitCount: number;
  git: Git;
  github: Github;
  mergeCommitSha: string;
  number: number;
  owner: string;
  repo: string;
}>): Promise<string[]> => {
  const { stdout: parents } = await git([
    "rev-list",
    "--parents",
    "--max-count=1",
    mergeCommitSha,
  ]);
  const parentCount = parents.trim().split(" ").length - 1;

  if (parentCount > 1 || commitCount <= 1) {
    return getCherryPickArgs({
      mergeCommitSha,
      mergedMessages: [],
      parentCount,
      pullRequestMessages: [],
    });
  }

  const pullRequestCommits = await github.paginate(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
    { owner, per_page: 100, pull_number: number, repo },
  );
  const { stdout: log } = await git([
    "log",
    "--format=%B%x00",
    "--reverse",
    `--max-count=${pullRequestCommits.length}`,
    mergeCommitSha,
  ]);

  return getCherryPickArgs({
    mergeCommitSha,
    mergedMessages: log
      .split("\0")
      .map((message) => message.trim())
      .filter(Boolean),
    parentCount,
    pullRequestMessages: pullRequestCommits.map(({ commit }) => commit.message),
  });
};

/**
 * Cherry-picks the changes on the current branch.
 * With the "draft" conflict resolution, conflicts are committed with their markers and the conflicted files are returned.
 */
const cherryPick = async ({
  cherryPickArgs,
  conflictResolution,
  git,
}: Readonly<{
  cherryPickArgs: readonly string[];
  conflictResolution: ConflictResolution;
  git: Git;
}>): Promise<string[]> => {
  const abort = async () => {
    await git(["cherry-pick", "--abort"], { ignoreReturnCode: true });
  };

  let result = await git(["cherry-pick", "-x", ...cherryPickArgs], {
    ignoreReturnCode: true,
  });
  const conflicts = new Set<string>();

  while (result.exitCode !== 0) {
    // eslint-disable-next-line no-await-in-loop
    const conflictedFiles = await getConflictedFiles(git);

    if (conflictedFiles.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await abort();
      throw new Error(
        `\`git cherry-pick\` failed:\n${(
          result.stderr || result.stdout
        ).trim()}`,
      );
    }

    if (conflictResolution === "fail") {
      // eslint-disable-next-line no-await-in-loop
      await abort();
      throw new Error(
        `The cherry-pick has conflicts in:\n${conflictedFiles
          .map((file) => `- ${file}`)
          .join("\n")}`,
      );
    }

    for (const file of conflictedFiles) {
      conflicts.add(file);
    }

    // eslint-disable-next-line no-await-in-loop
    await git(["add", "--all"]);
    // Continuing moves on to the next commit of a range, which can conflict too.
    // eslint-disable-next-line no-await-in-loop
    result = await git(
      ["-c", "core.editor=true", "cherry-pick", "--continue"],
      {
        ignoreReturnCode: true,
      },
    );
  }

  return [...conflicts];
};

const remoteBranchExists = async (git: Git, branch: string) => {
  const { exitCode } = await git(
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    { ignoreReturnCode: true },
  );
  return exitCode === 0;
};

const backportOnce = async ({
  author,
  base,
  body,
  cherryPickArgs,
  conflictResolution,
  git,
  github,
  head,
  labels,
  mergedBy,
  owner,
  repo,
  title,
}: Readonly<{
  author: string;
  base: string;
  body: string;
  cherryPickArgs: readonly string[];
  conflictResolution: ConflictResolution;
  git: Git;
  github: Github;
  head: string;
  labels: readonly string[];
  mergedBy: string;
  owner: string;
  repo: string;
  title: string;
}>): Promise<{ conflicts: string[]; number: number }> => {
  const { data: existingPullRequests } = await github.request(
    "GET /repos/{owner}/{repo}/pulls",
    { base, head: `${owner}:${head}`, owner, repo, state: "open" },
  );
  const [existingPullRequest] = existingPullRequests;
  if (existingPullRequest) {
    info(`PR #${existingPullRequest.number} already backports to ${base}.`);
    return { conflicts: [], number: existingPullRequest.number };
  }

  let conflicts: string[] = [];

  if (await remoteBranchExists(git, head)) {
    // Left over from a previous run that failed after pushing: reuse it instead of failing to push a new cherry-pick.
    info(`Branch ${head} already exists, reusing it.`);
  } else {
    if (!(await remoteBranchExists(git, base))) {
      throw new Error(`The \`${base}\` branch doesn't exist.`);
    }

    await git(["switch", base]);
    await git(["switch", "--create", head]);
    conflicts = await cherryPick({ cherryPickArgs, conflictResolution, git });
    await git(["push", "--set-upstream", "origin", head]);
  }

  const draft = conflicts.length > 0;
  const createPullRequest = async (asDraft: boolean) =>
    github.request("POST /repos/{owner}/{repo}/pulls", {
      base,
      body: draft
        ? `${getConflictsNotice({ conflicts, head })}\n\n${body}`
        : body,
      draft: asDraft,
      head,
      owner,
      repo,
      title,
    });

  let response;
  try {
    response = await createPullRequest(draft);
  } catch (error: unknown) {
    if (!draft) {
      throw error;
    }

    // Draft PRs aren't available on every plan.
    warning(
      `Could not create a draft PR, creating a regular one: ${
        ensureError(error).message
      }`,
    );
    response = await createPullRequest(false);
  }

  const {
    data: { number },
  } = response;
  info(`PR #${number} has been created.`);

  const reviewers = getReviewers({ author, mergedBy });
  if (reviewers.length > 0) {
    await bestEffort(`request reviews from ${reviewers.join(", ")}`, async () =>
      github.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
        { owner, pull_number: number, repo, reviewers },
      ),
    );
  }

  await bestEffort(`assign ${author}`, async () =>
    github.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
      { assignees: [author], issue_number: number, owner, repo },
    ),
  );

  if (labels.length > 0) {
    await bestEffort(`add labels ${labels.join(", ")}`, async () =>
      github.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        issue_number: number,
        labels: [...labels],
        owner,
        repo,
      }),
    );
  }

  return { conflicts, number };
};

const backport = async ({
  conflictResolution,
  getBody,
  getHead,
  getTitle,
  labelRegExp,
  payload,
  token,
}: {
  conflictResolution: ConflictResolution;
  getBody: (
    props: Readonly<{
      base: string;
      body: string;
      mergeCommitSha: string;
      number: number;
    }>,
  ) => string;
  getHead: (
    props: Readonly<{
      base: string;
      number: number;
    }>,
  ) => string;
  getTitle: (
    props: Readonly<{
      base: string;
      number: number;
      title: string;
    }>,
  ) => string;
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
  token: string;
}): Promise<{
  created: { [base: string]: number };
  failed: string[];
}> => {
  const {
    pull_request: {
      body: originalBody,
      commits: commitCount,
      labels: originalLabels,
      merge_commit_sha: mergeCommitSha,
      merged,
      merged_by: originalMergedBy,
      number,
      title: originalTitle,
      user: { login: author },
    },
    repository: {
      html_url: repositoryUrl,
      name: repo,
      owner: { login: owner },
    },
  } = payload;

  if (merged !== true || !mergeCommitSha) {
    // See https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request_target.
    throw new Error(
      "For security reasons, this action should only run on merged PRs.",
    );
  }

  const targets = getTargets({ labelRegExp, payload });

  if (targets.length === 0) {
    info("No backports required.");
    return { created: {}, failed: [] };
  }

  const github = getOctokit(token);

  info(`Backporting ${mergeCommitSha} from #${number}.`);

  const cloneUrl = new URL(payload.repository.clone_url);
  cloneUrl.username = "x-access-token";
  cloneUrl.password = token;

  // A fresh directory so that the cleanup below can never delete anything the workflow put in its workspace.
  const cwd = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "backport-"));
  const git = createGit({ cwd, secrets: [token] });

  const created: { [base: string]: number } = {};
  const failed: string[] = [];
  const originalLabelNames = originalLabels.map((label) => label.name);

  try {
    await git(["clone", cloneUrl.toString(), "."]);
    // Local config to leave the runner's global config untouched.
    await git([
      "config",
      "user.email",
      "github-actions[bot]@users.noreply.github.com",
    ]);
    await git(["config", "user.name", "github-actions[bot]"]);

    const cherryPickArgs = await resolveCherryPickArgs({
      commitCount,
      git,
      github,
      mergeCommitSha,
      number,
      owner,
      repo,
    });
    info(`Cherry-picking ${cherryPickArgs.join(" ")}.`);

    for (const { base, label } of targets) {
      const body = getBody({
        base,
        body: originalBody ?? "",
        mergeCommitSha,
        number,
      });
      const head = getHead({ base, number });
      const labels = originalLabelNames.filter(
        (name) =>
          !labelRegExp.test(name) && !name.startsWith("failed-backport-to-"),
      );
      labels.push("backport");

      const title = getTitle({ base, number, title: originalTitle });
      const mergedBy = originalMergedBy?.login ?? "";
      const failedLabel = `failed-backport-to-${base}`;

      // PRs are handled sequentially to avoid breaking GitHub's log grouping feature.
      // eslint-disable-next-line no-await-in-loop
      await group(`Backporting to ${base} on ${head}.`, async () => {
        try {
          assertSafeBranchName(head, "from head_template");
          const { conflicts, number: backportNumber } = await backportOnce({
            author,
            base,
            body,
            cherryPickArgs,
            conflictResolution,
            git,
            github,
            head,
            labels,
            mergedBy,
            owner,
            repo,
            title,
          });
          created[base] = backportNumber;

          if (conflicts.length > 0) {
            warning(
              `PR #${backportNumber} is a draft with conflicts in: ${conflicts.join(
                ", ",
              )}.`,
            );
          }

          await bestEffort("report the backport", async () =>
            upsertStatusComment({
              base,
              body: getSuccessCommentBody({
                base,
                conflicts,
                number: backportNumber,
              }),
              github,
              number,
              owner,
              repo,
            }),
          );

          if (originalLabelNames.includes(failedLabel)) {
            await bestEffort(`remove the ${failedLabel} label`, async () =>
              github.request(
                "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
                { issue_number: number, name: failedLabel, owner, repo },
              ),
            );
          }
        } catch (_error: unknown) {
          const error = ensureError(_error);
          logError(error);
          failed.push(base);

          await bestEffort("report the failed backport", async () => {
            await upsertStatusComment({
              base,
              body: getFailureCommentBody({
                base,
                body,
                cherryPickArgs,
                errorMessage: error.message,
                head,
                label,
                repositoryUrl,
                title,
              }),
              github,
              number,
              owner,
              repo,
            });
            await github.request(
              "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
              {
                issue_number: number,
                labels: [failedLabel],
                owner,
                repo,
              },
            );
          });
        }
      });
    }
  } finally {
    // The clone's config holds the token: don't leave it behind on self-hosted runners.
    await rm(cwd, { force: true, recursive: true });
  }

  return { created, failed };
};

export {
  backport,
  backportOnce,
  cherryPick,
  getCherryPickArgs,
  getReviewers,
  getTargets,
  isSafeBranchName,
  resolveCherryPickArgs,
};
export type { ConflictResolution };
