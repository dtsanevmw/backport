import { getExecOutput } from "@actions/exec";

type GitResult = Readonly<{ exitCode: number; stderr: string; stdout: string }>;

type Git = (
  args: string[],
  options?: Readonly<{ ignoreReturnCode?: boolean }>,
) => Promise<GitResult>;

// Git's output ends up in PR comments, where log masking doesn't apply.
const redact = (text: string, secrets: readonly string[]) => {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "***");
  }

  return redacted;
};

const createGit =
  ({
    cwd,
    secrets,
  }: Readonly<{ cwd: string; secrets: readonly string[] }>): Git =>
  async (args, { ignoreReturnCode = false } = {}) => {
    const result = await getExecOutput("git", args, {
      cwd,
      ignoreReturnCode: true,
    });

    if (result.exitCode !== 0 && !ignoreReturnCode) {
      const command = redact(`git ${args.join(" ")}`, secrets);
      const output = redact((result.stderr || result.stdout).trim(), secrets);
      throw new Error(
        output ? `\`${command}\` failed:\n${output}` : `\`${command}\` failed.`,
      );
    }

    return result;
  };

const getConflictedFiles = async (git: Git): Promise<string[]> => {
  const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"]);
  return stdout.split("\n").filter(Boolean);
};

export { createGit, getConflictedFiles, redact };
export type { Git, GitResult };
