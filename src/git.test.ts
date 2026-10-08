import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cherryPick, resolveCherryPickArgs } from "./backport.js";
import type { Git } from "./git.js";
import { createGit } from "./git.js";
import type { Github } from "./github.js";

// These tests run real git commands in a temporary repository.
describe("git", () => {
  let cwd: string;
  let git: Git;

  // Each scenario changes its own file so that they don't conflict with each other.
  const commit = async (message: string, content: string, file: string) => {
    await writeFile(join(cwd, file), content);
    await git(["add", file]);
    await git(["commit", "--message", message]);
    const { stdout } = await git(["rev-parse", "HEAD"]);
    return stdout.trim();
  };

  const fakeGithub = (messages: string[]) =>
    ({
      async paginate() {
        return messages.map((message) => ({ commit: { message } }));
      },
    } as unknown as Github);

  const resolve = async (
    mergeCommitSha: string,
    pullRequestMessages: string[],
  ) =>
    resolveCherryPickArgs({
      commitCount: pullRequestMessages.length,
      git,
      github: fakeGithub(pullRequestMessages),
      mergeCommitSha,
      number: 1,
      owner: "owner",
      repo: "repo",
    });

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "backport-test-"));
    git = createGit({ cwd, secrets: ["ghs_secret"] });
    await git(["init", "--initial-branch", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(cwd, "file.txt"), "a\nb\nc\n");
    await git(["add", "file.txt"]);
    await git(["commit", "--message", "initial"]);
    await git(["branch", "17.x"]);
  });

  beforeEach(async () => {
    await git(["switch", "--force", "main"]);
  });

  after(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("reports git's output without secrets", async () => {
    await assert.rejects(
      git(["switch", "ghs_secret"]),
      (error: Error) =>
        error.message.startsWith("`git switch ***` failed:\n") &&
        error.message.includes("invalid reference: ***") &&
        !error.message.includes("ghs_secret"),
    );
  });

  it("backports a squashed commit", async () => {
    const sha = await commit("fix: one (#1)", "squash\n", "squash.txt");
    const cherryPickArgs = await resolve(sha, ["one", "two"]);
    assert.deepEqual(cherryPickArgs, [sha]);

    await git(["switch", "--create", "squash", "17.x"]);
    assert.deepEqual(
      await cherryPick({ cherryPickArgs, conflictResolution: "fail", git }),
      [],
    );
    const { stdout } = await git(["log", "--format=%B", "--max-count=1"]);
    assert.match(stdout, new RegExp(`\\(cherry picked from commit ${sha}\\)`));
  });

  it("backports every commit of a rebase and merge", async () => {
    await commit("first", "first\n", "rebase.txt");
    const sha = await commit("second", "first\nsecond\n", "rebase.txt");
    const cherryPickArgs = await resolve(sha, ["first", "second"]);
    assert.deepEqual(cherryPickArgs, [`${sha}~2..${sha}`]);

    await git(["switch", "--create", "rebase", "17.x"]);
    await cherryPick({ cherryPickArgs, conflictResolution: "fail", git });
    const { stdout } = await git(["log", "--format=%s", "17.x..HEAD"]);
    assert.deepEqual(stdout.trim().split("\n"), ["second", "first"]);
  });

  it("backports a merge commit against its first parent", async () => {
    await git(["switch", "--create", "feature", "main"]);
    await commit("feature", "feature\n", "merge.txt");
    await git(["switch", "main"]);
    await git(["merge", "--no-ff", "--message", "Merge feature", "feature"]);
    const { stdout: sha } = await git(["rev-parse", "HEAD"]);
    const cherryPickArgs = await resolve(sha.trim(), ["feature"]);
    assert.deepEqual(cherryPickArgs, ["--mainline", "1", sha.trim()]);

    await git(["switch", "--create", "merge", "17.x"]);
    await cherryPick({ cherryPickArgs, conflictResolution: "fail", git });
    assert.equal(await readFile(join(cwd, "merge.txt"), "utf8"), "feature\n");
  });

  describe("conflicts", () => {
    let sha: string;

    before(async () => {
      sha = await commit("conflicting", "a\nB on main\nc\n", "file.txt");
      await git(["switch", "--create", "diverged", "17.x"]);
      await commit("diverge", "a\nB on 17.x\nc\n", "file.txt");
    });

    beforeEach(async () => {
      await git(["switch", "--force", "--force-create", "attempt", "diverged"]);
    });

    it("aborts and lists the conflicted files", async () => {
      await assert.rejects(
        cherryPick({ cherryPickArgs: [sha], conflictResolution: "fail", git }),
        /conflicts in:\n- file.txt/,
      );
      const { stdout } = await git(["status", "--porcelain"]);
      assert.equal(stdout, "");
    });

    it("commits the conflict markers in draft mode", async () => {
      assert.deepEqual(
        await cherryPick({
          cherryPickArgs: [sha],
          conflictResolution: "draft",
          git,
        }),
        ["file.txt"],
      );
      assert.match(await readFile(join(cwd, "file.txt"), "utf8"), /^<{7} /m);
      const { stdout } = await git(["log", "--format=%B", "--max-count=1"]);
      assert.match(stdout, /^conflicting/);
      assert.match(stdout, new RegExp(`cherry picked from commit ${sha}`));
    });
  });
});
