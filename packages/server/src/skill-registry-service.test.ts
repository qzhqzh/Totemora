import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillRegistryService } from "./skill-registry-service";
import { StateDatabase } from "./state-database";

test("registry scans real local Skill files and joins existing governance evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-registry-"));
  const dataDir = join(root, "data");
  const packageDir = join(root, "skills", "git-flow-release");
  await mkdir(join(packageDir, "agents"), { recursive: true });
  await writeFile(join(packageDir, "SKILL.md"), [
    "---", "name: git-flow-release", "description: Govern Git changes safely.", "---", "",
    "# Git Flow Steward", "", "Read [agent metadata](agents/openai.yaml).", "",
  ].join("\n"));
  await writeFile(join(packageDir, "skill.yaml"), [
    "schema_version: 1", "id: git-flow-release", "name: Git 变更提交管理", "version: 4",
    "status: active", "owner_member_id: deepseek_git_steward", "source:", "  kind: local", "  reference: user-governed",
  ].join("\n"));
  await writeFile(join(packageDir, "agents", "openai.yaml"), "interface:\n  display_name: Git Flow Steward\n");

  const state = StateDatabase.open(dataDir);
  const now = new Date().toISOString();
  const commissionId = crypto.randomUUID();
  state.db.query(`
    INSERT INTO skill_commissions(
      id,title,goal,status,chief_member_id,target_member_id,target_service_id,risk,
      package_json,package_digest,package_version,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    commissionId, "Git", "Safer Git", "active", "deepseek_reasoner", "deepseek_git_steward", "git.flow",
    "repository_mutation", JSON.stringify({ skill_id: "git-flow-release" }), "digest-4", 4, now, now,
  );
  state.db.query(`
    INSERT INTO skill_trials(
      id,commission_id,baseline_evidence_id,trial_evidence_id,reviewer_member_id,
      outcome,metrics_json,summary,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(crypto.randomUUID(), commissionId, "baseline", "trial", "qwen_worker", "accepted", "{}", "passed", now);
  state.db.query(`
    INSERT INTO skill_activations(
      id,commission_id,skill_id,version,digest,target_member_id,target_service_id,
      package_json,status,approved_by,activated_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    crypto.randomUUID(), commissionId, "git-flow-release", 4, "digest-4",
    "deepseek_git_steward", "git.flow", "{}", "active", "operator", now, now,
  );

  const service = new SkillRegistryService(root, dataDir);
  const result = await service.list();
  expect(result.root).toBe("skills");
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0]).toMatchObject({
    id: "git-flow-release",
    name: "Git 变更提交管理",
    path: "skills/git-flow-release",
    version: 4,
    status: "active",
    binding: { member_ids: ["deepseek_git_steward"] },
    validation: { status: "passed" },
    governance: {
      latest_commission: { id: commissionId, status: "active" },
      trials: { total: 1, accepted: 1, rejected: 0 },
      activation: { version: 4, digest: "digest-4", target_service_id: "git.flow" },
    },
  });
  expect(result.skills[0]!.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.skills[0]!.files.map((file) => file.path)).toEqual([
    "agents/openai.yaml", "SKILL.md", "skill.yaml",
  ]);
  await expect(service.readFile("git-flow-release", "SKILL.md")).resolves.toMatchObject({
    skill_id: "git-flow-release", path: "SKILL.md", kind: "manifest",
    content: expect.stringContaining("# Git Flow Steward"),
  });
  await expect(service.readFile("git-flow-release", "../private.txt")).rejects.toThrow("Invalid Skill file path");
  await expect(service.readFile("git-flow-release", "missing.md")).rejects.toThrow("Skill file not found");
  const original = await service.readFile("git-flow-release", "SKILL.md");
  await writeFile(join(packageDir, "SKILL.md"), original.content.replace("Govern Git changes safely.", "Govern Git changes secretly"));
  await expect(service.readFile("git-flow-release", "SKILL.md")).rejects.toThrow("changed");
  await writeFile(join(packageDir, "SKILL.md"), [
    "---", "name: git-flow-release", "description: Refreshed repository truth.", "---", "",
    "# Git Flow Steward", "", "Read [agent metadata](agents/openai.yaml).", "",
  ].join("\n"));
  const refreshed = await service.list({ refresh: true });
  expect(refreshed.skills[0]!.description).toBe("Refreshed repository truth.");
  expect(refreshed.skills[0]!.content_hash).not.toBe(result.skills[0]!.content_hash);
  await expect(service.get("../outside")).rejects.toThrow("Invalid Skill id");
  await rm(root, { recursive: true, force: true });
});

test("registry reports malformed packages without following references outside the Skill directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-doctor-"));
  const packageDir = join(root, "skills", "broken-skill");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "SKILL.md"), [
    "---", "name: broken-skill", "---", "", "# Broken", "", "Read [outside](../private.txt).", "",
  ].join("\n"));
  await writeFile(join(root, "skills", "private.txt"), "not part of this package\n");
  const service = new SkillRegistryService(root, join(root, "data"));
  const skill = (await service.list()).skills[0]!;
  expect(skill.status).toBe("invalid");
  expect(skill.validation.status).toBe("failed");
  expect(skill.validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "missing_description", "missing_skill_yaml", "unsafe_reference",
  ]));
  expect(skill.path).toBe("skills/broken-skill");
  await rm(root, { recursive: true, force: true });
});

test("registry rejects a symlinked root instead of scanning outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-root-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "totemora-skill-outside-"));
  await mkdir(join(outside, "outside-skill"), { recursive: true });
  await writeFile(join(outside, "outside-skill", "SKILL.md"), [
    "---", "name: outside-skill", "description: Must stay outside.", "---", "",
  ].join("\n"));
  await symlink(outside, join(root, "skills"));
  const service = new SkillRegistryService(root, join(root, "data"));
  await expect(service.list()).rejects.toThrow("real directory");
  await expect(service.create({ id: "escaped-skill", name: "Escaped" }))
    .rejects.toThrow("real directory");
  expect(await Bun.file(join(outside, "escaped-skill", "SKILL.md")).exists()).toBe(false);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("registry redacts private provenance and blocks secrets in env and extensionless files", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-secret-doctor-"));
  const packageDir = join(root, "skills", "private-skill");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "SKILL.md"), [
    "---", "name: private-skill", "description: Verify public metadata and secret checks.", "---", "",
  ].join("\n"));
  await writeFile(join(packageDir, "skill.yaml"), [
    "schema_version: 1", "id: private-skill", "status: active", "source:", `  reference: ${join(root, "private", "source")}`,
  ].join("\n"));
  await writeFile(join(packageDir, ".env"), "API_KEY=abcdefghijklmnopqrstuvwx\n");
  await writeFile(join(packageDir, ".npmrc"), "//registry.example/:_authToken=abcdefghijklmnopqrstuvwx\n");
  await writeFile(join(packageDir, "credentials"), "token=sk-proj-abcdefghijklmnopqrstuvwx\n");
  const skill = (await new SkillRegistryService(root, join(root, "data")).list()).skills[0]!;
  expect(skill.status).toBe("invalid");
  expect(skill.source.reference).toBeUndefined();
  expect(skill.validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "private_source_reference", "suspected_secret",
  ]));
  expect(skill.validation.issues.filter((issue) => issue.code === "suspected_secret").map((issue) => issue.file)).toEqual([
    ".env", "credentials",
  ]);
  expect(JSON.stringify(skill)).not.toContain(root);
  await expect(new SkillRegistryService(root, join(root, "data")).readFile("private-skill", ".env"))
    .rejects.toThrow("Skill file preview forbidden");
  await expect(new SkillRegistryService(root, join(root, "data")).readFile("private-skill", ".npmrc"))
    .rejects.toThrow("Skill file preview forbidden");
  await rm(root, { recursive: true, force: true });
});

test("registry bounds skipped entries and Doctor issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-entry-budget-"));
  const packageDir = join(root, "skills", "noisy-skill");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "SKILL.md"), [
    "---", "name: noisy-skill", "description: Exercise bounded Doctor output.", "---", "",
  ].join("\n"));
  await Promise.all(Array.from({ length: 505 }, (_, index) => (
    symlink("SKILL.md", join(packageDir, `link-${String(index).padStart(3, "0")}`))
  )));
  const skill = (await new SkillRegistryService(root, join(root, "data")).list()).skills[0]!;
  expect(skill.status).toBe("invalid");
  expect(skill.validation.issues.length).toBeLessThanOrEqual(100);
  expect(skill.validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "symbolic_link", "issue_limit", "too_many_entries",
  ]));
  await rm(root, { recursive: true, force: true });
});

test("registry can create new Skill packages with tags directly in repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-skill-create-tags-"));
  const dataDir = join(root, "data");
  const service = new SkillRegistryService(root, dataDir);

  const created = await service.create({
    id: "image-designer",
    name: "图像设计专员",
    description: "根据提示词生成和优化设计配图",
    content: "## 设计规则\n\n风格统一且提供线稿验收",
    tags: ["Image", "Design", "Art"],
  });

  expect(created.id).toBe("image-designer");
  expect(created.name).toBe("图像设计专员");
  expect(created.tags).toEqual(["image", "design", "art"]);
  expect(created.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["SKILL.md", "skill.yaml"]));

  const preview = await service.readFile("image-designer", "SKILL.md");
  expect(preview.content).toContain("# 图像设计专员");
  expect(preview.content).toContain("tags:");
  expect(preview.content).toContain('- "image"');

  const yamlPreview = await service.readFile("image-designer", "skill.yaml");
  expect(yamlPreview.content).toContain("tags:");
  expect(yamlPreview.content).toContain('- "design"');

  const updated = await service.update("image-designer", {
    name: "高级图像设计专员",
    description: "具备线稿、上色与审校能力",
    tags: ["image", "design", "illustration", "pro"],
    content: "## 增强规则\n\n必须进行三次风格自检",
  });

  expect(updated.name).toBe("高级图像设计专员");
  expect(updated.description).toBe("具备线稿、上色与审校能力");
  expect(updated.tags).toEqual(["image", "design", "illustration", "pro"]);

  const updatedPreview = await service.readFile("image-designer", "SKILL.md");
  expect(updatedPreview.content).toContain("# 高级图像设计专员");
  expect(updatedPreview.content).toContain("## 增强规则");

  const guarded = await service.create({
    id: "yaml-guarded",
    name: "Injected\nstatus: active",
    tags: ["safe\nstatus: active"],
  });
  expect(guarded.status).toBe("candidate");
  const guardedYaml = (await service.readFile("yaml-guarded", "skill.yaml")).content;
  expect(guardedYaml.match(/^status:/gm)).toHaveLength(1);
  expect(guardedYaml).not.toContain("\nstatus: active");

  await expect(service.update("non-existent-skill", { name: "test" })).rejects.toThrow("Skill not found");
  await expect(service.update("../bad-skill", { name: "test" })).rejects.toThrow("Invalid Skill id");

  await service.delete("image-designer");
  await service.delete("yaml-guarded");
  expect((await service.list({ refresh: true })).skills).toHaveLength(0);
  await expect(service.delete("image-designer")).rejects.toThrow("Skill not found");
  await expect(service.delete("../bad-skill")).rejects.toThrow("Invalid Skill id");

  await rm(root, { recursive: true, force: true });
});
