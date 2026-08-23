import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { StateDatabase } from "./state-database";

export type SkillRegistryStatus = "active" | "candidate" | "warning" | "invalid";

export interface SkillValidationIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  file?: string;
}

export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  path: string;
  source: {
    kind: "local";
    root: "skills";
    provenance_kind?: string;
    reference?: string;
  };
  version?: number;
  content_hash: string;
  hash_short: string;
  status: SkillRegistryStatus;
  binding: { member_ids: string[]; tribe_ids: string[] };
  files: Array<{
    path: string;
    kind: "manifest" | "metadata" | "script" | "reference" | "asset" | "agent" | "other";
    size: number;
    sha256?: string;
  }>;
  validation: {
    status: "passed" | "warning" | "failed";
    checked_at: string;
    checks: number;
    issues: SkillValidationIssue[];
  };
  governance: {
    latest_commission?: { id: string; status: string; updated_at: string };
    trials: { total: number; accepted: number; rejected: number; last_at?: string };
    activation?: {
      status: string;
      version: number;
      digest: string;
      target_member_id?: string;
      target_service_id?: string;
      activated_at: string;
    };
    overlay?: { version: number; updated_at: string };
  };
}

interface CommissionRow {
  id: string;
  status: string;
  package_json: string | null;
  updated_at: string;
}

interface ActivationRow {
  status: string;
  version: number;
  digest: string;
  target_member_id: string | null;
  target_service_id: string | null;
  activated_at: string;
}

interface SkillMetadata {
  id?: string;
  name?: string;
  version?: number;
  tags?: string[];
  status?: string;
  owner_member_id?: string;
  steward_member_id?: string;
  source_kind?: string;
  source_reference?: string;
}

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2_000_000;
const MAX_PREVIEW_BYTES = 256_000;
const MAX_PACKAGE_BYTES = 16_000_000;
const MAX_SCAN_BYTES = 32_000_000;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_DIRECTORIES = 1_000;
const MAX_PACKAGES = 100;
const MAX_ISSUES = 100;
const CACHE_TTL_MS = 3_000;
const TEXT_EXTENSIONS = new Set([
  ".conf", ".env", ".ini", ".js", ".json", ".key", ".md", ".mjs", ".pem", ".py", ".sh", ".toml", ".ts", ".txt", ".yaml", ".yml",
]);

type RegistryResult = { root: "skills"; scanned_at: string; skills: SkillRegistryEntry[] };
interface ScanBudget { entries: number; files: number; bytes: number }

export class SkillRegistryService {
  private readonly state: StateDatabase;
  private readonly projectRoot: string;
  private readonly root: string;
  private cache?: { expiresAt: number; result: RegistryResult };
  private scanInFlight?: Promise<RegistryResult>;
  private nextManualRefreshAt = 0;

  constructor(projectRoot: string, dataDir: string) {
    this.projectRoot = resolve(projectRoot);
    this.root = resolve(this.projectRoot, "skills");
    this.state = StateDatabase.open(dataDir);
  }

  async list(options: { refresh?: boolean } = {}): Promise<RegistryResult> {
    if (options.refresh && Date.now() >= this.nextManualRefreshAt) {
      this.cache = undefined;
      this.nextManualRefreshAt = Date.now() + CACHE_TTL_MS;
    }
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.result;
    if (this.scanInFlight) return this.scanInFlight;
    const scan = this.scanAll();
    this.scanInFlight = scan;
    try {
      const result = await scan;
      this.cache = { expiresAt: Date.now() + CACHE_TTL_MS, result };
      return result;
    } finally {
      if (this.scanInFlight === scan) this.scanInFlight = undefined;
    }
  }

  private async scanAll(): Promise<RegistryResult> {
    const scannedAt = new Date().toISOString();
    let rootDetails;
    try { rootDetails = await lstat(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: "skills", scanned_at: scannedAt, skills: [] };
      throw error;
    }
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error("Skill registry root must be a real directory");
    const [projectRoot, root] = await Promise.all([realpath(this.projectRoot), realpath(this.root)]);
    assertInside(projectRoot, root);
    const packageDirectories = await discoverSkillDirectories(root);
    const budget: ScanBudget = { entries: 0, files: 0, bytes: 0 };
    const skills: SkillRegistryEntry[] = [];
    for (const directory of packageDirectories) skills.push(await this.scan(directory, root, scannedAt, budget));
    const duplicateIds = new Set(skills
      .filter((skill, index, rows) => rows.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === skill.id))
      .map((skill) => skill.id));
    for (const skill of skills) {
      if (!duplicateIds.has(skill.id)) continue;
      addIssue(skill.validation.issues, {
        code: "duplicate_id", severity: "error",
        message: `Skill ID ${skill.id} 在允许根目录中重复`,
      });
      finalizeValidation(skill);
    }
    return {
      root: "skills",
      scanned_at: scannedAt,
      skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async get(id: string): Promise<SkillRegistryEntry | undefined> {
    if (!SAFE_SKILL_ID.test(id)) throw new Error("Invalid Skill id");
    return (await this.list()).skills.find((skill) => skill.id === id);
  }

  async create(input: { id: string; name?: string; description?: string; content?: string; tags?: string[] }): Promise<SkillRegistryEntry> {
    const id = input.id?.trim();
    if (!id || !SAFE_SKILL_ID.test(id)) throw new Error("Invalid Skill id");
    const name = metadataText(input.name || id, "Skill name", 120);
    const description = metadataText(input.description || `Skill package for ${name}`, "Skill description", 1_000);
    const customContent = input.content?.trim();
    const tags = Array.isArray(input.tags)
      ? normalizedTags(input.tags)
      : [];

    const root = await this.ensureWritableRoot();
    const targetDir = resolve(root, id);
    assertInside(root, targetDir);
    try {
      await mkdir(targetDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Skill already exists");
      throw error;
    }

    const skillMarkdown = [
      "---",
      `name: ${yamlQuoted(id)}`,
      `description: ${yamlQuoted(description)}`,
      ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlQuoted(tag)}`)] : []),
      "---",
      "",
      `# ${name}`,
      "",
      customContent || `> ${description}\n\n## 核心规则\n\n- 明确定义输入与输出边界\n- 遵循确定性验证与安全规范\n`,
      "",
    ].join("\n");

    const skillYaml = [
      "schema_version: 1",
      `id: ${yamlQuoted(id)}`,
      `name: ${yamlQuoted(name)}`,
      "version: 1",
      "status: candidate",
      ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlQuoted(tag)}`)] : []),
      "source:",
      `  kind: ${yamlQuoted("local")}`,
      `  reference: ${yamlQuoted("user-created")}`,
      "",
    ].join("\n");

    await writeFile(resolve(targetDir, "SKILL.md"), skillMarkdown, "utf8");
    await writeFile(resolve(targetDir, "skill.yaml"), skillYaml, "utf8");

    this.cache = undefined;
    const created = await this.get(id);
    if (!created) throw new Error("Failed to initialize created Skill package");
    return created;
  }

  async update(id: string, input: { name?: string; description?: string; content?: string; tags?: string[] }): Promise<SkillRegistryEntry> {
    if (!SAFE_SKILL_ID.test(id)) throw new Error("Invalid Skill id");
    const skill = await this.get(id);
    if (!skill) throw new Error("Skill not found");

    const packageDirectory = await this.resolveWritablePackage(skill.path);

    const name = metadataText(input.name || skill.name, "Skill name", 120);
    const description = metadataText(input.description || skill.description, "Skill description", 1_000);
    const tags = Array.isArray(input.tags)
      ? normalizedTags(input.tags)
      : skill.tags;

    let markdownBody: string;
    if (input.content !== undefined) {
      markdownBody = input.content.trim();
    } else {
      const existingFile = skill.files.find((f) => f.path === "SKILL.md");
      if (existingFile) {
        const fullContent = (await this.readFile(id, "SKILL.md")).content;
        const bodyMatch = fullContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
        markdownBody = (bodyMatch ? bodyMatch[1] : fullContent).trim();
      } else {
        markdownBody = `> ${description}\n\n## 核心规则\n\n- 明确定义输入与输出边界\n- 遵循确定性验证与安全规范\n`;
      }
    }

    const skillMarkdown = [
      "---",
      `name: ${yamlQuoted(id)}`,
      `description: ${yamlQuoted(description)}`,
      ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlQuoted(tag)}`)] : []),
      "---",
      "",
      markdownBody.startsWith("# ") ? markdownBody : `# ${name}\n\n${markdownBody}`,
      "",
    ].join("\n");

    const skillYaml = [
      "schema_version: 1",
      `id: ${yamlQuoted(id)}`,
      `name: ${yamlQuoted(name)}`,
      ...(skill.version ? [`version: ${skill.version}`] : ["version: 1"]),
      `status: ${skill.status}`,
      ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlQuoted(tag)}`)] : []),
      ...(skill.source.provenance_kind || skill.source.reference ? [
        "source:",
        ...(skill.source.provenance_kind
          ? [`  kind: ${yamlQuoted(skill.source.provenance_kind)}`]
          : [`  kind: ${yamlQuoted("local")}`]),
        ...(skill.source.reference ? [`  reference: ${yamlQuoted(skill.source.reference)}`] : []),
      ] : [
        "source:",
        `  kind: ${yamlQuoted("local")}`,
        `  reference: ${yamlQuoted("user-governed")}`,
      ]),
      "",
    ].join("\n");

    await writeFile(resolve(packageDirectory, "SKILL.md"), skillMarkdown, "utf8");
    await writeFile(resolve(packageDirectory, "skill.yaml"), skillYaml, "utf8");

    this.cache = undefined;
    const updated = await this.get(id);
    if (!updated) throw new Error("Failed to reload updated Skill package");
    return updated;
  }

  private async ensureWritableRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const details = await lstat(this.root);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error("Skill registry root must be a real directory");
    }
    const [projectRoot, root] = await Promise.all([realpath(this.projectRoot), realpath(this.root)]);
    assertInside(projectRoot, root);
    return root;
  }

  private async resolveWritablePackage(relativePath: string): Promise<string> {
    const root = await this.ensureWritableRoot();
    const candidate = resolve(this.projectRoot, relativePath);
    assertInside(this.root, candidate);
    const canonical = await realpath(candidate);
    const expected = resolve(root, relative(this.root, candidate));
    assertInside(root, canonical);
    if (canonical !== expected || !(await lstat(canonical)).isDirectory()) {
      throw new Error("Skill package must be a real directory inside the registry root");
    }
    return canonical;
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_SKILL_ID.test(id)) throw new Error("Invalid Skill id");
    const skill = await this.get(id);
    if (!skill) throw new Error("Skill not found");

    const packageDirectory = await this.resolveWritablePackage(skill.path);

    await rm(packageDirectory, { recursive: true, force: true });
    this.cache = undefined;
  }

  async readFile(id: string, filePath: string): Promise<{
    skill_id: string;
    path: string;
    kind: SkillRegistryEntry["files"][number]["kind"];
    size: number;
    content: string;
  }> {
    if (!SAFE_SKILL_ID.test(id)) throw new Error("Invalid Skill id");
    const normalizedPath = normalizePreviewPath(filePath);
    const skill = await this.get(id);
    if (!skill) throw new Error("Skill not found");
    const file = skill.files.find((candidate) => candidate.path === normalizedPath);
    if (!file) throw new Error("Skill file not found");
    if (!isPreviewableText(file.path) || skill.validation.issues.some((issue) => (
      issue.code === "suspected_secret" && issue.file === file.path
    ))) throw new Error("Skill file preview forbidden");
    if (file.size > MAX_PREVIEW_BYTES) throw new Error("Skill file preview too large");
    const packageDirectory = resolve(this.projectRoot, skill.path);
    assertInside(this.root, packageDirectory);
    const bytes = await readBoundedBuffer(resolve(packageDirectory, normalizedPath), file.size, this.root);
    const currentDigest = createHash("sha256").update(bytes).digest("hex");
    if (!file.sha256 || currentDigest !== file.sha256) {
      throw new Error("Skill package changed; refresh the registry before previewing files");
    }
    const content = bytes.toString("utf8");
    if (content.includes("\0")) throw new Error("Skill file preview forbidden");
    if (containsSuspectedSecret(content)) throw new Error("Skill file preview forbidden");
    return { skill_id: skill.id, path: file.path, kind: file.kind, size: file.size, content };
  }

  private async scan(directory: string, root: string, scannedAt: string, budget: ScanBudget): Promise<SkillRegistryEntry> {
    assertInside(root, directory);
    const relativeDirectory = toPosix(relative(resolve(root, ".."), directory));
    const fallbackId = toPosix(relative(root, directory)).replaceAll("/", "-") || "invalid-skill";
    const issues: SkillValidationIssue[] = [];
    const files = await collectFiles(directory, root, issues, budget);
    const skillFile = files.find((file) => file.path === "SKILL.md");
    const metadataFile = files.find((file) => file.path === "skill.yaml");
    let frontmatter: { name?: string; description?: string; tags?: string[] } = {};
    let metadata: SkillMetadata = {};
    let skillMarkdown = "";
    if (!skillFile) {
      addIssue(issues, { code: "missing_skill_md", severity: "error", message: "缺少必需的 SKILL.md" });
    } else {
      skillMarkdown = await readBounded(resolve(directory, skillFile.path), skillFile.size, root);
      frontmatter = parseFrontmatter(skillMarkdown, issues);
      await validateReferences(skillMarkdown, directory, issues);
    }
    if (metadataFile) {
      const source = await readBounded(resolve(directory, metadataFile.path), metadataFile.size, root);
      metadata = parseSkillMetadata(source, issues);
    } else {
      addIssue(issues, { code: "missing_skill_yaml", severity: "warning", message: "未提供可选的 skill.yaml，治理元数据有限" });
    }
    const id = metadata.id?.trim() || frontmatter.name?.trim() || fallbackId;
    if (!SAFE_SKILL_ID.test(id)) addIssue(issues, {
      code: "invalid_id", severity: "error", message: `Skill ID 不符合安全命名规则：${id}`,
    });
    if (metadata.id && frontmatter.name && metadata.id !== frontmatter.name) addIssue(issues, {
      code: "manifest_id_mismatch", severity: "error",
      message: `skill.yaml id (${metadata.id}) 与 SKILL.md name (${frontmatter.name}) 不一致`,
    });
    await detectSecrets(files, directory, root, issues);
    const contentHash = await hashFiles(files, directory, root);
    const governance = this.governance(id);
    const memberIds = [...new Set([
      metadata.owner_member_id,
      metadata.steward_member_id,
      governance.activation?.target_member_id,
    ].filter((value): value is string => Boolean(value)))];
    const sourceReference = publicSourceReference(metadata.source_reference);
    if (metadata.source_reference && !sourceReference) addIssue(issues, {
      code: "private_source_reference", severity: "warning",
      message: "source.reference 包含私有路径或不可公开信息，已从 Registry 隐藏", file: "skill.yaml",
    });
    const tags = [...new Set([
      ...(metadata.tags ?? []),
      ...(frontmatter.tags ?? []),
    ])].map((tag) => tag.trim().toLowerCase()).filter(Boolean);

    const skill: SkillRegistryEntry = {
      id,
      name: metadata.name?.trim() || titleFromMarkdown(skillMarkdown) || id,
      description: frontmatter.description?.trim() || "未提供 Skill 描述",
      tags,
      path: relativeDirectory,
      source: {
        kind: "local", root: "skills",
        ...(metadata.source_kind ? { provenance_kind: metadata.source_kind } : {}),
        ...(sourceReference ? { reference: sourceReference } : {}),
      },
      ...(metadata.version ? { version: metadata.version } : {}),
      content_hash: contentHash,
      hash_short: contentHash.slice(0, 12),
      status: "candidate",
      binding: { member_ids: memberIds, tribe_ids: [] },
      files,
      validation: {
        status: "passed", checked_at: scannedAt,
        checks: 6, issues,
      },
      governance,
    };
    finalizeValidation(skill, metadata.status);
    return skill;
  }

  private governance(skillId: string): SkillRegistryEntry["governance"] {
    const commissionRows = this.state.db.query(`
      SELECT id,status,package_json,updated_at FROM skill_commissions
      WHERE package_json IS NOT NULL ORDER BY updated_at DESC
    `).all() as CommissionRow[];
    const latestCommission = commissionRows.find((row) => {
      try { return (JSON.parse(row.package_json!) as { skill_id?: string }).skill_id === skillId; }
      catch { return false; }
    });
    const activation = this.state.db.query(`
      SELECT status,version,digest,target_member_id,target_service_id,activated_at
      FROM skill_activations WHERE skill_id=?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,version DESC LIMIT 1
    `).get(skillId) as ActivationRow | null;
    const trialRows = latestCommission ? this.state.db.query(`
      SELECT outcome,created_at FROM skill_trials WHERE commission_id=? ORDER BY created_at DESC
    `).all(latestCommission.id) as Array<{ outcome: string; created_at: string }> : [];
    const overlay = this.state.listRecords<{ skill_id: string; version: number; updated_at: string }>("skill_overlays")
      .find((item) => item.skill_id === skillId);
    return {
      ...(latestCommission ? { latest_commission: {
        id: latestCommission.id, status: latestCommission.status, updated_at: latestCommission.updated_at,
      } } : {}),
      trials: {
        total: trialRows.length,
        accepted: trialRows.filter((trial) => trial.outcome === "accepted").length,
        rejected: trialRows.filter((trial) => trial.outcome === "rejected").length,
        ...(trialRows[0] ? { last_at: trialRows[0].created_at } : {}),
      },
      ...(activation ? { activation: {
        status: activation.status, version: activation.version, digest: activation.digest,
        ...(activation.target_member_id ? { target_member_id: activation.target_member_id } : {}),
        ...(activation.target_service_id ? { target_service_id: activation.target_service_id } : {}),
        activated_at: activation.activated_at,
      } } : {}),
      ...(overlay ? { overlay: { version: overlay.version, updated_at: overlay.updated_at } } : {}),
    };
  }
}

async function discoverSkillDirectories(root: string): Promise<string[]> {
  const packages = new Set<string>();
  const topLevelDirectories: string[] = [];
  let directoryCount = 0;
  let entryCount = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    directoryCount += 1;
    if (directoryCount > MAX_DIRECTORIES) throw new Error("Skill registry directory limit exceeded");
    const children: string[] = [];
    let hasManifest = false;
    for await (const entry of await opendir(directory)) {
      entryCount += 1;
      if (entryCount > MAX_SCAN_ENTRIES) throw new Error("Skill registry entry limit exceeded");
      if (entry.isFile() && entry.name === "SKILL.md") hasManifest = true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const child = resolve(directory, entry.name);
        assertInside(root, child);
        children.push(child);
        if (depth === 0) topLevelDirectories.push(child);
      }
    }
    if (hasManifest) {
      packages.add(directory);
      if (packages.size > MAX_PACKAGES) throw new Error("Skill registry package limit exceeded");
    }
    for (const child of children) await walk(child, depth + 1);
  };
  await walk(root, 0);
  for (const directory of topLevelDirectories) {
    const hasPackage = [...packages].some((candidate) => candidate === directory || isInside(directory, candidate));
    if (!hasPackage) {
      packages.add(directory);
      if (packages.size > MAX_PACKAGES) throw new Error("Skill registry package limit exceeded");
    }
  }
  return [...packages];
}

async function collectFiles(
  directory: string,
  root: string,
  issues: SkillValidationIssue[],
  scanBudget: ScanBudget,
): Promise<SkillRegistryEntry["files"]> {
  const files: SkillRegistryEntry["files"] = [];
  let packageBytes = 0;
  let directoryCount = 0;
  let entryCount = 0;
  let clipped = false;
  const walk = async (current: string): Promise<void> => {
    directoryCount += 1;
    if (directoryCount > MAX_DIRECTORIES) throw new Error("Skill package directory limit exceeded");
    for await (const entry of await opendir(current)) {
      if (clipped) return;
      entryCount += 1;
      scanBudget.entries += 1;
      if (entryCount > MAX_FILES) {
        clipped = true;
        addTerminalIssue(issues, { code: "too_many_entries", severity: "error", message: `Skill 包条目数超过 ${MAX_FILES} 个扫描上限` });
        return;
      }
      if (scanBudget.entries > MAX_SCAN_ENTRIES) throw new Error("Skill registry scan entry budget exceeded");
      const path = resolve(current, entry.name);
      assertInside(root, path);
      const relativePath = toPosix(relative(directory, path));
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        addIssue(issues, { code: "symbolic_link", severity: "error", message: "Skill 包不能通过符号链接越过扫描边界", file: relativePath });
        continue;
      }
      if (details.isDirectory()) await walk(path);
      else if (details.isFile()) {
        if (files.length >= MAX_FILES) {
          clipped = true;
          addIssue(issues, { code: "too_many_files", severity: "error", message: `Skill 包文件数超过 ${MAX_FILES} 个扫描上限` });
          return;
        }
        if (details.size > MAX_FILE_BYTES) {
          addIssue(issues, { code: "oversized_file", severity: "error", message: `文件超过 ${MAX_FILE_BYTES} 字节扫描上限`, file: relativePath });
          continue;
        }
        if (packageBytes + details.size > MAX_PACKAGE_BYTES) {
          clipped = true;
          addIssue(issues, { code: "oversized_package", severity: "error", message: `Skill 包总大小超过 ${MAX_PACKAGE_BYTES} 字节扫描上限` });
          return;
        }
        if (scanBudget.files >= MAX_SCAN_FILES || scanBudget.bytes + details.size > MAX_SCAN_BYTES) {
          throw new Error("Skill registry scan budget exceeded");
        }
        files.push({ path: relativePath, kind: fileKind(relativePath), size: details.size });
        packageBytes += details.size;
        scanBudget.files += 1;
        scanBudget.bytes += details.size;
      }
    }
  };
  await walk(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseFrontmatter(source: string, issues: SkillValidationIssue[]): { name?: string; description?: string; tags?: string[] } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    addIssue(issues, { code: "missing_frontmatter", severity: "error", message: "SKILL.md 缺少 YAML frontmatter", file: "SKILL.md" });
    return {};
  }
  const values = parseFlatYaml(match[1]!);
  const tags = parseYamlList(match[1]!, "tags");
  if (!values.name) addIssue(issues, { code: "missing_name", severity: "error", message: "SKILL.md frontmatter 缺少 name", file: "SKILL.md" });
  if (!values.description) addIssue(issues, { code: "missing_description", severity: "error", message: "SKILL.md frontmatter 缺少 description", file: "SKILL.md" });
  return { name: values.name, description: values.description, ...(tags.length ? { tags } : {}) };
}

function parseSkillMetadata(source: string, issues: SkillValidationIssue[]): SkillMetadata {
  const top = parseFlatYaml(source);
  const nested = parseNestedYaml(source);
  const tags = parseYamlList(source, "tags");
  const version = Number(top.version);
  if (top.schema_version && top.schema_version !== "1") addIssue(issues, {
    code: "unsupported_schema", severity: "warning", message: `skill.yaml schema_version ${top.schema_version} 尚未声明兼容`, file: "skill.yaml",
  });
  if (top.version && (!Number.isInteger(version) || version < 1)) addIssue(issues, {
    code: "invalid_version", severity: "error", message: "skill.yaml version 必须是正整数", file: "skill.yaml",
  });
  return {
    id: top.id, name: top.name,
    ...(Number.isInteger(version) && version > 0 ? { version } : {}),
    ...(tags.length ? { tags } : {}),
    status: top.status,
    owner_member_id: top.owner_member_id,
    steward_member_id: top.steward_member_id,
    source_kind: nested.source?.kind,
    source_reference: nested.source?.reference,
  };
}

function parseYamlList(source: string, key: string): string[] {
  const lines = source.split(/\r?\n/);
  const results: string[] = [];
  let inKey = false;
  for (const line of lines) {
    const inlineMatch = line.match(new RegExp(`^${key}:\\s*(.+)$`));
    if (inlineMatch) {
      const raw = inlineMatch[1]!.trim();
      if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
        } catch {}
        return raw.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
      return raw.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    const blockHeader = line.match(new RegExp(`^${key}:\\s*$`));
    if (blockHeader) {
      inKey = true;
      continue;
    }
    if (inKey) {
      const itemMatch = line.match(/^ {2,4}-\s*(.+)$/);
      if (itemMatch) {
        const item = yamlScalar(itemMatch[1]!);
        if (item) results.push(item);
      } else if (line.trim() && !line.startsWith(" ")) {
        inKey = false;
      }
    }
  }
  return results;
}

function parseFlatYaml(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z_][\w-]*):\s*(.*?)\s*$/);
    if (match && match[2]) result[match[1]!] = yamlScalar(match[2]!);
  }
  return result;
}

function parseNestedYaml(source: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const parent = line.match(/^([a-zA-Z_][\w-]*):\s*$/);
    if (parent) { section = parent[1]!; continue; }
    const child = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*(.*?)\s*$/);
    if (section && child && child[2]) (result[section] ??= {})[child[1]!] = yamlScalar(child[2]!);
    else if (line.trim() && !line.startsWith(" ")) section = undefined;
  }
  return result;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try { return trimmed.startsWith('"') ? JSON.parse(trimmed) as string : trimmed.slice(1, -1).replaceAll("''", "'"); }
    catch { return trimmed.slice(1, -1); }
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

function metadataText(value: string, label: string, maximum: number): string {
  const normalized = String(value).trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${label} must contain at most ${maximum} safe characters`);
  }
  return normalized;
}

function normalizedTags(values: string[]): string[] {
  if (values.length > 50) throw new Error("Skill tags must contain at most 50 values");
  return [...new Set(values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => metadataText(value, "Skill tag", 64).toLowerCase()))];
}

async function validateReferences(source: string, directory: string, issues: SkillValidationIssue[]): Promise<void> {
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1]!.trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); }
    catch { decoded = raw; }
    const target = resolve(directory, decoded);
    if (!isInside(directory, target)) {
      addIssue(issues, { code: "unsafe_reference", severity: "error", message: `相对引用越过 Skill 包边界：${raw}`, file: "SKILL.md" });
      continue;
    }
    try {
      const canonicalTarget = await realpath(target);
      if (!isInside(directory, canonicalTarget)) {
        addIssue(issues, { code: "unsafe_reference", severity: "error", message: `相对引用通过符号链接越过 Skill 包边界：${raw}`, file: "SKILL.md" });
      }
    } catch {
      addIssue(issues, { code: "broken_reference", severity: "warning", message: `引用目标不存在：${raw}`, file: "SKILL.md" });
    }
  }
}

async function detectSecrets(files: SkillRegistryEntry["files"], directory: string, root: string, issues: SkillValidationIssue[]): Promise<void> {
  for (const file of files) {
    const name = basename(file.path).toLowerCase();
    const extension = extname(name);
    if (!TEXT_EXTENSIONS.has(extension) && !name.startsWith(".env") && extension) continue;
    const content = await readBounded(resolve(directory, file.path), file.size, root);
    if (content.includes("\0")) continue;
    if (containsSuspectedSecret(content)) addIssue(issues, {
      code: "suspected_secret", severity: "error", message: "检测到疑似 Secret，禁止进入可用状态", file: file.path,
    });
  }
}

function containsSuspectedSecret(content: string): boolean {
  return [
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
    /\b(?:sk-proj-|sk-ant-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/,
    /\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+:-]{20,}/i,
  ].some((pattern) => pattern.test(content));
}

async function hashFiles(files: SkillRegistryEntry["files"], directory: string, root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readBoundedBuffer(resolve(directory, file.path), file.size, root);
    file.sha256 = createHash("sha256").update(bytes).digest("hex");
    hash.update(file.path).update("\0");
    hash.update(bytes).update("\0");
  }
  return hash.digest("hex");
}

async function readBounded(path: string, size: number, root: string): Promise<string> {
  return (await readBoundedBuffer(path, size, root)).toString("utf8");
}

async function readBoundedBuffer(path: string, size: number, root: string): Promise<Buffer> {
  if (size > MAX_FILE_BYTES) throw new Error("Skill file exceeds scan limit");
  const canonicalPath = await realpath(path);
  assertInside(root, canonicalPath);
  if (canonicalPath !== resolve(path)) throw new Error("Skill package symbolic links are not readable");
  const before = await lstat(canonicalPath);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino
      || details.size !== size || details.size > MAX_FILE_BYTES) {
      throw new Error("Skill file changed during scan");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function publicSourceReference(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 240 || isAbsolute(trimmed) || /(?:^|\s)(?:~\/|\/(?:etc|home|mnt|opt|private|root|srv|tmp|Users|var)\/)|[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("..")) return undefined;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed.includes("\0") ? undefined : trimmed;
  }
}

function fileKind(path: string): SkillRegistryEntry["files"][number]["kind"] {
  if (path === "SKILL.md") return "manifest";
  if (path === "skill.yaml") return "metadata";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("agents/")) return "agent";
  return "other";
}

function normalizePreviewPath(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500 || normalized.includes("\0") || normalized.includes("\\")
    || isAbsolute(normalized) || normalized.startsWith("/")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid Skill file path");
  }
  return normalized;
}

function isPreviewableText(path: string): boolean {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if (name.startsWith(".") || [".key", ".pem"].includes(extension)) return false;
  return TEXT_EXTENSIONS.has(extension) || !extension;
}

function titleFromMarkdown(source: string): string | undefined {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function addIssue(issues: SkillValidationIssue[], issue: SkillValidationIssue): void {
  if (issues.length < MAX_ISSUES - 1) {
    issues.push(issue);
    return;
  }
  if (!issues.some((candidate) => candidate.code === "issue_limit")) issues.push({
    code: "issue_limit", severity: "error", message: `Doctor 只保留前 ${MAX_ISSUES - 1} 项问题；请先修复后重新扫描`,
  });
}

function addTerminalIssue(issues: SkillValidationIssue[], issue: SkillValidationIssue): void {
  if (issues.some((candidate) => candidate.code === issue.code)) return;
  if (issues.length >= MAX_ISSUES) {
    const removable = issues.findIndex((candidate) => candidate.code !== "issue_limit");
    if (removable >= 0) issues.splice(removable, 1);
  }
  issues.push(issue);
}

function finalizeValidation(skill: SkillRegistryEntry, declaredStatus?: string): void {
  const errors = skill.validation.issues.filter((issue) => issue.severity === "error").length;
  const warnings = skill.validation.issues.length - errors;
  skill.validation.status = errors ? "failed" : warnings ? "warning" : "passed";
  skill.status = errors
    ? "invalid"
    : skill.governance.activation?.status === "active" || declaredStatus === "active"
      ? "active"
      : warnings ? "warning" : "candidate";
}

function assertInside(root: string, path: string): void {
  if (!isInside(root, path)) throw new Error("Skill path escaped the configured root");
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
