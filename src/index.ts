import { getInput, setFailed, setOutput, setSecret } from "@actions/core";
import { context } from "@actions/github";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { template } from "lodash-es";
import { backport } from "./backport.js";

const run = async () => {
  try {
    const [getBody, getHead, getTitle] = [
      "body_template",
      "head_template",
      "title_template",
    ].map((name) => template(getInput(name)));

    const labelPattern = getInput("label_pattern");
    const labelRegExp = new RegExp(labelPattern);

    const conflictResolution = getInput("conflict_resolution") || "fail";
    if (conflictResolution !== "fail" && conflictResolution !== "draft") {
      throw new Error(
        `Unsupported conflict_resolution "${conflictResolution}": use "fail" or "draft".`,
      );
    }

    const token = getInput("github_token", { required: true });
    setSecret(token);

    if (!context.payload.pull_request) {
      throw new Error(`Unsupported event action: ${context.payload.action}.`);
    }

    const payload = context.payload as PullRequestEvent;

    if (payload.action !== "closed" && payload.action !== "labeled") {
      throw new Error(
        `Unsupported pull request event action: ${payload.action}.`,
      );
    }

    const { created, failed } = await backport({
      conflictResolution,
      getBody,
      getHead,
      getTitle,
      labelRegExp,
      payload,
      token,
    });
    setOutput("created_pull_requests", JSON.stringify(created));

    if (failed.length > 0) {
      throw new Error(`Backport failed for: ${failed.join(", ")}.`);
    }
  } catch (_error: unknown) {
    const error = ensureError(_error);
    setFailed(error);
  }
};

void run();
