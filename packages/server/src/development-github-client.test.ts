import { expect, test } from "bun:test";

import { DevelopmentGitHubClient } from "./development-github-client";

test("GitHub client returns validated Issue and Pull Request data", async () => {
  const external = async (_cwd: string, _command: string, args: string[]) => {
    const operation = `${args[0]} ${args[1]}`;
    if (operation === "issue create") {
      return { stdout: "https://github.com/totemora/app/issues/17\n", stderr: "" };
    }
    if (operation === "issue list") {
      return { stdout: JSON.stringify([
        { number: 17, url: "https://github.com/totemora/app/issues/17", body: "<!-- totemora-proposal-proposal-1 -->" },
      ]), stderr: "" };
    }
    if (operation === "pr list") {
      return { stdout: JSON.stringify([{ number: 23, url: "https://github.com/totemora/app/pull/23" }]), stderr: "" };
    }
    if (operation === "pr view" && args.includes("files")) {
      return { stdout: JSON.stringify({ files: [{ path: "src/app.ts" }] }), stderr: "" };
    }
    if (operation === "pr view" && args.includes("state,isDraft,mergeStateStatus,url")) {
      return { stdout: JSON.stringify({
        state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN",
        url: "https://github.com/totemora/app/pull/23",
      }), stderr: "" };
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const client = new DevelopmentGitHubClient(external);

  expect(await client.createIssue("/repo", "Title", "Body")).toEqual({
    number: 17, url: "https://github.com/totemora/app/issues/17",
  });
  expect(await client.findIssueByMarker("/repo", "totemora-proposal-proposal-1")).toEqual({
    number: 17, url: "https://github.com/totemora/app/issues/17",
  });
  expect(await client.findOpenPullRequest("/repo", "feat/demo", "main")).toEqual({
    number: 23, url: "https://github.com/totemora/app/pull/23",
  });
  expect(await client.pullRequestFiles("/repo", 23)).toEqual(["src/app.ts"]);
  expect(await client.pullRequestState("/repo", 23)).toMatchObject({
    state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN",
  });
});

test("GitHub client uses a bounded HTTPS fallback only for SSH transport failures", async () => {
  const gitCalls: string[][] = [];
  const runGit = async (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "push" && args[2] === "origin") {
      throw new Error("ssh: connect to host github.com port 22: Connection refused");
    }
    return { stdout: "", stderr: "" };
  };
  const external = async () => ({
    stdout: JSON.stringify({ url: "https://github.com/totemora/app" }), stderr: "",
  });
  const client = new DevelopmentGitHubClient(external, runGit);

  expect(await client.pushBranch("/repo", "feat/demo")).toBe("GitHub HTTPS fallback");
  expect(gitCalls).toEqual([
    ["push", "-u", "origin", "feat/demo"],
    ["-c", "credential.helper=!gh auth git-credential", "push", "https://github.com/totemora/app.git", "feat/demo"],
  ]);
});

test("GitHub client rejects malformed CLI JSON before it reaches the workflow", async () => {
  const client = new DevelopmentGitHubClient(async () => ({ stdout: "not-json", stderr: "" }));
  await expect(client.findOpenPullRequest("/repo", "feat/demo", "main"))
    .rejects.toThrow("GitHub CLI returned an invalid response for pr list; expected valid JSON");
});
