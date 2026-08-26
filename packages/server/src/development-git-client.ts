import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { WorkplacePolicy } from "./settlement-store";

export interface GitSnapshot {
  hash: string;
  files: string[];
  status: string;
  diff: string;
  conventions: string;
  branch: string;
  branches: string;
  unpushed: string;
  stash: string;
}

export type ExternalCommandRunner = (
  cwd: string,
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export async function collectGitSnapshot(root: string, policy: WorkplacePolicy): Promise<GitSnapshot> {
  await git(root, ["rev-parse", "--show-toplevel"]);
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    try {
      await stat(join(root, ".git", marker));
      throw new Error(`Git operation in progress: ${marker}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const cached = await git(root, ["diff", "--cached", "--name-only"]);
  if (cached.stdout.trim()) throw new Error("Development commit workflow requires no pre-staged changes");
  const tracked = lines((await git(root, ["diff", "--name-only", "HEAD"])).stdout);
  const untracked = lines((await git(root, ["ls-files", "--others", "--exclude-standard"])).stdout);
  const files = [...new Set([...tracked, ...untracked])].sort();
  if (!files.length) throw new Error("Git workplace has no changes to commit");
  for (const file of files) {
    assertSafePath(file, policy);
    try {
      const content = await readFile(join(root, file));
      if (!content.includes(0)) assertNoSecretContent(file, content.toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const status = (await git(root, ["status", "--short", "--untracked-files=all"])).stdout;
  const branch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("Development commit workflow requires a named Git branch");
  const branches = (await git(root, ["branch", "--all", "--no-color"])).stdout.trim();
  const unpushed = (await gitOptional(root, ["log", "@{upstream}..HEAD", "--oneline"])).trim();
  const stash = (await git(root, ["stash", "list"])).stdout.trim();
  let diff = (await git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", ...tracked])).stdout;
  for (const file of untracked) {
    const content = await readBoundedText(join(root, file), 8_000);
    diff += `\n--- /dev/null\n+++ b/${file}\n[untracked preview]\n${content}`;
  }
  diff = diff.slice(0, 60_000);
  const conventions = await readConventionFiles(root);
  const hash = createHash("sha256");
  hash.update(status);
  hash.update(JSON.stringify({ policy_version: policy.version, files, branch, branches, unpushed, stash }));
  for (const file of files) {
    try { hash.update(await readFile(join(root, file))); }
    catch { hash.update("[deleted]"); }
  }
  return { hash: hash.digest("hex"), files, status, diff, conventions, branch, branches, unpushed, stash };
}

export function assertSafePath(file: string, policy: WorkplacePolicy): void {
  const normalized = file.replaceAll("\\", "/");
  const defaultForbidden = [".env", "*.pem", "*.key", "*credentials*", "*secret*", ".totemora/"];
  const patterns = [...defaultForbidden, ...policy.forbidden_paths];
  if (normalized.startsWith("/") || normalized.includes("../")
    || patterns.some((pattern) => pathMatches(normalized, pattern))) {
    throw new Error(`Forbidden path cannot be committed: ${file}`);
  }
}

export async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
}

export const runExternalCommand: ExternalCommandRunner = async (cwd, command, args) => {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args[0] ?? ""} failed: ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
};

export async function runValidation(command: string, cwd: string) {
  const child = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { command, exit_code: exitCode, output: `${stdout}\n${stderr}`.trim().slice(-20_000) };
}

export function countLines(value: string): number {
  return value.trim() ? value.trim().split("\n").length : 0;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoSecretContent(file: string, content: string): void {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-proj-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{16,}/,
    /\bAKIA[A-Z0-9]{16}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(content))) {
    throw new Error(`Secret-like content cannot be committed without manual handling: ${file}`);
  }
}

function pathMatches(file: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").toLowerCase();
  const candidate = file.toLowerCase();
  if (normalized.includes("*")) {
    const expression = normalized.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${expression}$`).test(candidate);
  }
  return candidate === normalized
    || candidate.startsWith(normalized.endsWith("/") ? normalized : `${normalized}/`)
    || basename(candidate) === normalized;
}

async function readConventionFiles(root: string): Promise<string> {
  const candidates = ["AGENTS.md", "CONTRIBUTING.md", "docs/development.md", ".github/CONTRIBUTING.md"];
  const parts: string[] = [];
  for (const file of candidates) {
    try { parts.push(`## ${file}\n${await readBoundedText(join(root, file), 12_000)}`); }
    catch { /* Optional convention file. */ }
  }
  return parts.join("\n\n").slice(0, 30_000);
}

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const value = await readFile(path);
  if (value.includes(0)) throw new Error(`Binary file requires manual review: ${path}`);
  return value.subarray(0, maxBytes).toString("utf8");
}

async function gitOptional(cwd: string, args: string[]): Promise<string> {
  try { return (await git(cwd, args)).stdout; }
  catch { return ""; }
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function lines(value: string): string[] {
  return value.trim().split("\n").filter(Boolean);
}
