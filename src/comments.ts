import type { Github } from "./github.js";

// Identifies the comment the action keeps up to date for each target branch.
const getMarker = (base: string) => `<!-- backport-status: ${base} -->`;

const formatFiles = (files: readonly string[]) =>
  files.map((file) => `- \`${file}\``).join("\n");

// Browsers and GitHub reject very long URLs, so the body is left out when it doesn't fit.
const maxUrlLength = 8000;

const getCompareUrl = ({
  base,
  body,
  head,
  repositoryUrl,
  title,
}: Readonly<{
  base: string;
  body: string;
  head: string;
  repositoryUrl: string;
  title: string;
}>) => {
  const url = `${repositoryUrl}/compare/${base}...${head}?expand=1&title=${encodeURIComponent(
    title,
  )}`;
  const urlWithBody = `${url}&body=${encodeURIComponent(body)}`;
  return urlWithBody.length <= maxUrlLength ? urlWithBody : url;
};

const getSuccessCommentBody = ({
  base,
  conflicts,
  number,
}: Readonly<{ base: string; conflicts: readonly string[]; number: number }>) =>
  [
    getMarker(base),
    conflicts.length > 0
      ? `Backported to \`${base}\` in #${number} as a draft. The conflicts in these files must be resolved there before it can be merged:\n\n${formatFiles(
          conflicts,
        )}`
      : `Backported to \`${base}\` in #${number}.`,
  ].join("\n");

const getFailureCommentBody = ({
  base,
  body,
  cherryPickArgs,
  errorMessage,
  head,
  label,
  repositoryUrl,
  title,
}: Readonly<{
  base: string;
  body: string;
  cherryPickArgs: readonly string[];
  errorMessage: string;
  head: string;
  label: string;
  repositoryUrl: string;
  title: string;
}>) => {
  const worktreePath = `.worktrees/backport-${base}`;
  return [
    getMarker(base),
    `The backport to \`${base}\` failed:`,
    "```",
    errorMessage,
    "```",
    `To retry, remove the \`${label}\` label and add it again.`,
    "",
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
    "# Cherry-pick the changes of this pull request and resolve the conflicts",
    `git cherry-pick -x ${cherryPickArgs.join(" ")}`,
    "# Push it to GitHub",
    `git push --set-upstream origin ${head}`,
    "# Go back to the original working tree",
    "cd ../..",
    "# Delete the working tree",
    `git worktree remove ${worktreePath}`,
    "```",
    `Then, [create the pull request](${getCompareUrl({
      base,
      body,
      head,
      repositoryUrl,
      title,
    })}).`,
  ].join("\n");
};

const getConflictsNotice = ({
  conflicts,
  head,
}: Readonly<{ conflicts: readonly string[]; head: string }>) =>
  [
    "> [!WARNING]",
    "> This backport has conflicts. The conflict markers were committed so that they can be resolved here:",
    ...formatFiles(conflicts)
      .split("\n")
      .map((line) => `> ${line}`),
    ">",
    "> ```bash",
    "> git fetch",
    `> git switch ${head}`,
    "> # Resolve the conflicts, then:",
    '> git commit --all --message "fix: resolve backport conflicts"',
    "> git push",
    "> ```",
    ">",
    "> Then mark this pull request as ready for review.",
  ].join("\n");

const upsertStatusComment = async ({
  base,
  body,
  github,
  number,
  owner,
  repo,
}: Readonly<{
  base: string;
  body: string;
  github: Github;
  number: number;
  owner: string;
  repo: string;
}>) => {
  const comments = await github.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { issue_number: number, owner, per_page: 100, repo },
  );
  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" && comment.body?.includes(getMarker(base)),
  );

  await (existing
    ? github.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          body,
          comment_id: existing.id,
          owner,
          repo,
        },
      )
    : github.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          body,
          issue_number: number,
          owner,
          repo,
        },
      ));
};

export {
  getCompareUrl,
  getConflictsNotice,
  getFailureCommentBody,
  getSuccessCommentBody,
  upsertStatusComment,
};
