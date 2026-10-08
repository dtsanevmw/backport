import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { group, info, error as logError, warning } from "@actions/core";
import { exec } from "@actions/exec";
import { getOctokit } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils.js";
import type {
  PullRequestClosedEvent,
  PullRequestLabeledEvent,
} from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { compact } from "lodash-es";

type Github = InstanceType<typeof GitHub>;

type Git = (
  args: string[],
  options?: Readonly<{ ignoreReturnCode?: boolean }>,
) => Promise<number>;

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

const getBaseBranchFromLabel = (
  label: string,
  labelRegExp: RegExp,
): string | undefined => {
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

  return base;
};

const getBaseBranches = ({
  labelRegExp,
  payload,
}: Readonly<{
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
}>): string[] => {
  if ("label" in payload) {
    const base = getBaseBranchFromLabel(payload.label.name, labelRegExp);
    return base ? [base] : [];
  }

  return compact(
    payload.pull_request.labels.map((label) =>
      getBaseBranchFromLabel(label.name, labelRegExp),
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

const warnIfSquashIsNotTheOnlyAllowedMergeMethod = async ({
  github,
  owner,
  repo,
}: {
  github: Github;
  owner: string;
  repo: string;
}) => {
  const {
    data: { allow_merge_commit, allow_rebase_merge },
  } = await github.request("GET /repos/{owner}/{repo}", { owner, repo });
  if (allow_merge_commit || allow_rebase_merge) {
    warning(
      [
        "Your repository allows merge commits and rebase merging.",
        " However, Backport only supports rebased and merged pull requests with a single commit and squashed and merged pull requests.",
        " Consider only allowing squash merging.",
        " See https://help.github.com/en/github/administering-a-repository/about-merge-methods-on-github for more information.",
      ].join("\n"),
    );
  }
};

const backportOnce = async ({
  author,
  base,
  body,
  commitSha,
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
  commitSha: string;
  git: Git;
  github: Github;
  head: string;
  labels: readonly string[];
  mergedBy: string;
  owner: string;
  repo: string;
  title: string;
}>): Promise<number> => {
  const { data: existingPullRequests } = await github.request(
    "GET /repos/{owner}/{repo}/pulls",
    { base, head: `${owner}:${head}`, owner, repo, state: "open" },
  );
  const [existingPullRequest] = existingPullRequests;
  if (existingPullRequest) {
    info(`PR #${existingPullRequest.number} already backports to ${base}.`);
    return existingPullRequest.number;
  }

  const remoteBranchExists =
    (await git(["ls-remote", "--exit-code", "--heads", "origin", head], {
      ignoreReturnCode: true,
    })) === 0;

  if (remoteBranchExists) {
    // Left over from a previous run that failed after pushing: reuse it instead of failing to push a new cherry-pick.
    info(`Branch ${head} already exists, reusing it.`);
  } else {
    await git(["switch", base]);
    await git(["switch", "--create", head]);
    try {
      await git(["cherry-pick", "-x", commitSha]);
    } catch (error: unknown) {
      // Aborting fails when the cherry-pick did not start, which must not hide the original error.
      await git(["cherry-pick", "--abort"], { ignoreReturnCode: true });
      throw error;
    }

    await git(["push", "--set-upstream", "origin", head]);
  }

  const {
    data: { number },
  } = await github.request("POST /repos/{owner}/{repo}/pulls", {
    base,
    body,
    head,
    owner,
    repo,
    title,
  });
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

  return number;
};

const getFailedBackportCommentBody = ({
  base,
  commitSha,
  errorMessage,
  head,
}: {
  base: string;
  commitSha: string;
  errorMessage: string;
  head: string;
}) => {
  const worktreePath = `.worktrees/backport-${base}`;
  return [
    `The backport to \`${base}\` failed:`,
    "```",
    errorMessage,
    "```",
    "To backport manually, run these commands in your terminal:",
    "```bash",
    "# Fetch latest updates from GitHub",
    "git fetch",
    "# Create a new working tree",
    `git worktree add ${worktreePath} ${base}`,
    "# Navigate to the new working tree",
    `cd ${worktreePath}`,
    "# Create a new branch",
    `git switch --create ${head}`,
    "# Cherry-pick the merged commit of this pull request and resolve the conflicts",
    `git cherry-pick -x --mainline 1 ${commitSha}`,
    "# Push it to GitHub",
    `git push --set-upstream origin ${head}`,
    "# Go back to the original working tree",
    "cd ../..",
    "# Delete the working tree",
    `git worktree remove ${worktreePath}`,
    "```",
    `Then, create a pull request where the \`base\` branch is \`${base}\` and the \`compare\`/\`head\` branch is \`${head}\`.`,
  ].join("\n");
};

const backport = async ({
  getBody,
  getHead,
  getTitle,
  labelRegExp,
  payload,
  token,
}: {
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
      labels: originalLabels,
      merge_commit_sha: mergeCommitSha,
      merged,
      merged_by: originalMergedBy,
      number,
      title: originalTitle,
      user: { login: author },
    },
    repository: {
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

  const baseBranches = getBaseBranches({ labelRegExp, payload });

  if (baseBranches.length === 0) {
    info("No backports required.");
    return { created: {}, failed: [] };
  }

  const github = getOctokit(token);

  await warnIfSquashIsNotTheOnlyAllowedMergeMethod({ github, owner, repo });

  info(`Backporting ${mergeCommitSha} from #${number}.`);

  const cloneUrl = new URL(payload.repository.clone_url);
  cloneUrl.username = "x-access-token";
  cloneUrl.password = token;

  // A fresh directory so that the cleanup below can never delete anything the workflow put in its workspace.
  const cwd = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "backport-"));
  const git: Git = async (args, { ignoreReturnCode = false } = {}) =>
    exec("git", args, { cwd, ignoreReturnCode });

  const created: { [base: string]: number } = {};
  const failed: string[] = [];

  try {
    await git(["clone", cloneUrl.toString(), "."]);
    // Local config to leave the runner's global config untouched.
    await git([
      "config",
      "user.email",
      "github-actions[bot]@users.noreply.github.com",
    ]);
    await git(["config", "user.name", "github-actions[bot]"]);

    for (const base of baseBranches) {
      const body = getBody({
        base,
        body: originalBody ?? "",
        mergeCommitSha,
        number,
      });
      const head = getHead({ base, number });
      const labels = originalLabels
        .map((label) => label.name)
        .filter((label) => !labelRegExp.test(label));
      labels.push("backport");

      const title = getTitle({ base, number, title: originalTitle });
      const mergedBy = originalMergedBy?.login ?? "";

      // PRs are handled sequentially to avoid breaking GitHub's log grouping feature.
      // eslint-disable-next-line no-await-in-loop
      await group(`Backporting to ${base} on ${head}.`, async () => {
        try {
          assertSafeBranchName(head, "from head_template");
          created[base] = await backportOnce({
            author,
            base,
            body,
            commitSha: mergeCommitSha,
            git,
            github,
            head,
            labels,
            mergedBy,
            owner,
            repo,
            title,
          });
        } catch (_error: unknown) {
          const error = ensureError(_error);
          logError(error);
          failed.push(base);

          await bestEffort("report the failed backport", async () => {
            await github.request(
              "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
              {
                body: getFailedBackportCommentBody({
                  base,
                  commitSha: mergeCommitSha,
                  errorMessage: error.message,
                  head,
                }),
                issue_number: number,
                owner,
                repo,
              },
            );
            await github.request(
              "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
              {
                issue_number: number,
                labels: [`failed-backport-to-${base}`],
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
  getBaseBranches,
  getReviewers,
  isSafeBranchName,
};
export type { Git, Github };
