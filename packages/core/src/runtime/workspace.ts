import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";

import type { WorkspaceFile, WorkspaceSnapshot } from "./types";

export interface WorkspaceSnapshotOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULTS = {
  maxFiles: 80,
  maxFileBytes: 12_000,
  maxTotalBytes: 120_000,
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".totemora",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const ALLOWED_EXTENSIONLESS = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
]);

export async function collectWorkspaceSnapshot(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const root = resolve(workspaceRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }

  const maxFiles = positiveInteger(options.maxFiles, DEFAULTS.maxFiles);
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULTS.maxFileBytes,
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULTS.maxTotalBytes,
  );
  const candidates = await collectCandidates(root);
  candidates.sort(compareCandidatePaths);

  const files: WorkspaceFile[] = [];
  let totalBytes = 0;
  let omittedFiles = 0;

  for (const filePath of candidates) {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
      omittedFiles += 1;
      continue;
    }
    const remaining = maxTotalBytes - totalBytes;
    const readLimit = Math.min(maxFileBytes, remaining);
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      omittedFiles += 1;
      continue;
    }
    const selected = buffer.subarray(0, readLimit);
    const content = redactSensitiveText(selected.toString("utf8"));
    const bytes = Buffer.byteLength(content);
    if (bytes === 0 && buffer.length > 0) {
      omittedFiles += 1;
      continue;
    }
    files.push({
      path: normalizePath(relative(root, filePath)),
      content,
      truncated: buffer.length > selected.length,
    });
    totalBytes += bytes;
  }

  return {
    root,
    files,
    omitted_files: omittedFiles,
    total_bytes: totalBytes,
  };
}

async function collectCandidates(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      results.push(...(await collectCandidates(fullPath)));
      continue;
    }
    if (entry.isFile() && isSafeTextCandidate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function isSafeTextCandidate(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (
    lower.startsWith(".") ||
    lower.includes(".env") ||
    /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/.test(lower) ||
    lower.endsWith(".lock") ||
    lower === "package-lock.json"
  ) {
    return false;
  }
  return ALLOWED_EXTENSIONLESS.has(fileName) ||
    ALLOWED_EXTENSIONS.has(extname(lower));
}

function compareCandidatePaths(left: string, right: string): number {
  const priority = (path: string): number => {
    const name = basename(path).toLowerCase();
    if (name.startsWith("readme") || name === "package.json" || name === "pyproject.toml") {
      return 0;
    }
    if (normalizePath(path).includes("/src/") || normalizePath(path).includes("/packages/")) {
      return 1;
    }
    if (extname(name) === ".md") {
      return 2;
    }
    return 3;
  };
  return priority(left) - priority(right) || left.localeCompare(right);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function redactSensitiveText(content: string): string {
  return content
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(
      /\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}
