import {
  type ExternalCommandRunner,
  git,
  runExternalCommand,
} from "./development-git-client";

export interface GitHubReference {
  number: number;
  url: string;
}

export interface GitHubPullRequestState {
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  url: string;
}

export interface GitHubMergedPullRequest {
  state: string;
  mergedAt?: string;
  mergeCommit?: { oid?: string };
  url: string;
}

type GitCommandRunner = typeof git;
type GitTransport = "configured origin" | "GitHub HTTPS fallback";

export class DevelopmentGitHubClient {
  constructor(
    private readonly externalCommand: ExternalCommandRunner = runExternalCommand,
    private readonly gitCommand: GitCommandRunner = git,
  ) {}

  async createIssue(cwd: string, title: string, body: string): Promise<GitHubReference> {
    const result = await this.externalCommand(cwd, "gh", ["issue", "create", "--title", title, "--body", body]);
    return referenceFromOutput(result.stdout, "issues");
  }

  async findIssueByMarker(cwd: string, marker: string): Promise<GitHubReference | undefined> {
    const value = await this.json(cwd, [
      "issue", "list", "--state", "all", "--search", marker,
      "--limit", "20", "--json", "number,url,body",
    ]);
    if (!Array.isArray(value)) throw invalidResponse("issue list", "an array");
    for (const item of value) {
      const candidate = object(item, "issue list item");
      if (typeof candidate.body !== "string") {
        throw invalidResponse("issue list item.body", "a string");
      }
      const body = candidate.body;
      if (body.includes(marker)) return referenceFromObject(candidate, "issue list");
    }
    return undefined;
  }

  async findOpenPullRequest(cwd: string, head: string, base: string): Promise<GitHubReference | undefined> {
    const value = await this.json(cwd, [
      "pr", "list", "--head", head, "--base", base,
      "--state", "open", "--limit", "1", "--json", "number,url",
    ]);
    if (!Array.isArray(value)) throw invalidResponse("pr list", "an array");
    return value.length ? referenceFromObject(value[0], "pr list") : undefined;
  }

  async editPullRequest(cwd: string, number: number, title: string, body: string): Promise<void> {
    await this.externalCommand(cwd, "gh", [
      "pr", "edit", String(number), "--title", title, "--body", body,
    ]);
  }

  async createPullRequest(
    cwd: string,
    input: { base: string; head: string; title: string; body: string },
  ): Promise<GitHubReference> {
    const result = await this.externalCommand(cwd, "gh", [
      "pr", "create", "--base", input.base, "--head", input.head,
      "--title", input.title, "--body", input.body,
    ]);
    return referenceFromOutput(result.stdout, "pull");
  }

  async pullRequestDiff(cwd: string, number: number): Promise<string> {
    return (await this.externalCommand(cwd, "gh", ["pr", "diff", String(number)])).stdout;
  }

  async pullRequestFiles(cwd: string, number: number): Promise<string[]> {
    const value = object(await this.json(cwd, ["pr", "view", String(number), "--json", "files"]), "pr view files");
    if (value.files === undefined) return [];
    if (!Array.isArray(value.files)) throw invalidResponse("pr view files", "a files array");
    return value.files.map((file) => requiredString(object(file, "pr view file").path, "pr view file.path"));
  }

  async pullRequestState(cwd: string, number: number): Promise<GitHubPullRequestState> {
    const value = object(await this.json(cwd, [
      "pr", "view", String(number), "--json", "state,isDraft,mergeStateStatus,url",
    ]), "pr view state");
    return {
      state: requiredString(value.state, "pr view state.state"),
      isDraft: requiredBoolean(value.isDraft, "pr view state.isDraft"),
      mergeStateStatus: requiredString(value.mergeStateStatus, "pr view state.mergeStateStatus"),
      url: requiredString(value.url, "pr view state.url"),
    };
  }

  async mergePullRequest(cwd: string, number: number): Promise<void> {
    await this.externalCommand(cwd, "gh", ["pr", "merge", String(number), "--squash", "--delete-branch"]);
  }

  async deleteRemoteBranchIfPresent(cwd: string, branch: string): Promise<GitTransport | "already absent"> {
    try {
      return await this.deleteRemoteBranch(cwd, "origin", branch, []);
    } catch (error) {
      if (!isSshTransportFailure(error)) throw error;
      const repositoryUrl = await this.repositoryUrl(cwd, error);
      return this.deleteRemoteBranch(
        cwd, `${repositoryUrl}.git`, branch,
        ["-c", "credential.helper=!gh auth git-credential"],
      );
    }
  }

  async mergedPullRequest(cwd: string, number: number): Promise<GitHubMergedPullRequest> {
    const value = object(await this.json(cwd, [
      "pr", "view", String(number), "--json", "state,mergedAt,mergeCommit,url",
    ]), "pr view merge result");
    const mergeCommit = value.mergeCommit === undefined || value.mergeCommit === null
      ? undefined
      : object(value.mergeCommit, "pr view merge result.mergeCommit");
    return {
      state: requiredString(value.state, "pr view merge result.state"),
      mergedAt: optionalString(value.mergedAt, "pr view merge result.mergedAt"),
      mergeCommit: mergeCommit ? { oid: optionalString(mergeCommit.oid, "pr view merge result.mergeCommit.oid") } : undefined,
      url: requiredString(value.url, "pr view merge result.url"),
    };
  }

  async pushBranch(cwd: string, branch: string): Promise<GitTransport> {
    try {
      await this.gitCommand(cwd, ["push", "-u", "origin", branch]);
      return "configured origin";
    } catch (error) {
      if (!isSshTransportFailure(error)) throw error;
      const repositoryUrl = await this.repositoryUrl(cwd, error);
      await this.gitCommand(cwd, [
        "-c", "credential.helper=!gh auth git-credential",
        "push", `${repositoryUrl}.git`, branch,
      ]);
      return "GitHub HTTPS fallback";
    }
  }

  async syncTargetBranch(cwd: string, branch: string): Promise<GitTransport> {
    try {
      await this.gitCommand(cwd, ["pull", "--ff-only", "origin", branch]);
      await this.gitCommand(cwd, ["fetch", "--prune", "origin"]);
      return "configured origin";
    } catch (error) {
      if (!isSshTransportFailure(error)) throw error;
      const repositoryUrl = await this.repositoryUrl(cwd, error);
      const authenticated = ["-c", "credential.helper=!gh auth git-credential"];
      await this.gitCommand(cwd, [...authenticated, "pull", "--ff-only", `${repositoryUrl}.git`, branch]);
      await this.gitCommand(cwd, [...authenticated, "fetch", "--prune", `${repositoryUrl}.git`]);
      return "GitHub HTTPS fallback";
    }
  }

  private async repositoryUrl(cwd: string, cause: unknown): Promise<string> {
    const value = object(await this.json(cwd, ["repo", "view", "--json", "url"]), "repo view");
    const url = requiredString(value.url, "repo view.url");
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
      throw new Error("GitHub HTTPS fallback could not resolve a safe repository URL", { cause });
    }
    return url;
  }

  private async deleteRemoteBranch(
    cwd: string,
    remote: string,
    branch: string,
    prefix: string[],
  ): Promise<GitTransport | "already absent"> {
    const reference = `refs/heads/${branch}`;
    const existing = await this.gitCommand(cwd, [...prefix, "ls-remote", "--heads", remote, reference]);
    if (!existing.stdout.trim()) return "already absent";
    await this.gitCommand(cwd, [...prefix, "push", remote, "--delete", branch]);
    return remote === "origin" ? "configured origin" : "GitHub HTTPS fallback";
  }

  private async json(cwd: string, args: string[]): Promise<unknown> {
    const output = (await this.externalCommand(cwd, "gh", args)).stdout;
    try { return JSON.parse(output); }
    catch { throw invalidResponse(`${args[0] ?? "command"} ${args[1] ?? ""}`.trim(), "valid JSON"); }
  }
}

function referenceFromOutput(value: string, segment: "issues" | "pull"): GitHubReference {
  const url = value.trim().split("\n").filter(Boolean).at(-1);
  if (!url) throw new Error("GitHub CLI returned no resource URL");
  const match = url.match(new RegExp(`/${segment}/(\\d+)(?:$|[?#])`));
  if (!match) throw new Error(`Cannot parse GitHub ${segment} number from ${url}`);
  return { number: Number(match[1]), url };
}

function referenceFromObject(value: unknown, operation: string): GitHubReference {
  const candidate = object(value, operation);
  const number = candidate.number;
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    throw invalidResponse(operation, "a positive PR number");
  }
  return { number: number as number, url: requiredString(candidate.url, `${operation}.url`) };
}

function object(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(operation, "an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(field, "a non-empty string");
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse(field, "a boolean");
  return value;
}

function invalidResponse(operation: string, expected: string): Error {
  return new Error(`GitHub CLI returned an invalid response for ${operation}; expected ${expected}`);
}

function isSshTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(port 22|Could not read from remote repository|ssh:)/i.test(message);
}
