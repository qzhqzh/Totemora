import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentConfig, LocalConfigSet } from "@totemora/core";

export type ToolAssetMaturity = "candidate" | "experimental" | "verified" | "disabled";

export interface ToolAsset {
  id: string;
  name: string;
  kind: "tool_service" | "tool_adapter" | "infrastructure" | "knowledge";
  maturity: ToolAssetMaturity;
  version: number;
  summary: string;
  executor: string;
  actions: string[];
  risk: "low" | "medium" | "high";
  default_access: "allow" | "ask" | "deny";
  policy_requirements: string[];
  blueprint: { source: string; notes: string };
}

export interface ToolAssetUse {
  id: string;
  asset_id: string;
  member_id: string;
  workflow_id: string;
  action: string;
  outcome: "completed" | "failed";
  evidence: string;
  at: string;
}

interface AssetCatalog { schema_version: 1; assets: ToolAsset[] }

export class ToolAssetRegistry {
  private readonly catalogPath: string;
  private readonly usagePath: string;
  private readonly proposalsDir: string;
  private writeQueue = Promise.resolve();

  constructor(projectRoot: string, dataDir: string) {
    this.catalogPath = resolve(projectRoot, "assets/tool-assets.json");
    this.usagePath = resolve(dataDir, "asset-usage.json");
    this.proposalsDir = resolve(dataDir, "development", "proposals");
  }

  async list(config: LocalConfigSet) {
    const catalog = await this.loadCatalog();
    const usage = await this.loadUsage();
    const workflowEvidence = await this.loadWorkflowEvidence();
    return catalog.assets.map((asset) => {
      const assetUsage = usage.filter((item) => item.asset_id === asset.id);
      const authorizedMembers = config.agents.agents
        .filter((member) => (member.tools ?? []).includes(asset.id))
        .map((member) => ({ id: member.id, name: member.name ?? member.id, status: member.status ?? "active" }));
      return {
        ...asset,
        authorized_members: authorizedMembers,
        usage_count: assetUsage.length,
        last_used_at: assetUsage.at(-1)?.at,
        recent_usage: assetUsage.slice(-10).reverse(),
        evidence: asset.id === "git-flow-engine" ? workflowEvidence : [],
      };
    });
  }

  async assertCanUse(member: AgentConfig, assetId: string, action: string): Promise<ToolAsset> {
    const asset = (await this.loadCatalog()).assets.find((item) => item.id === assetId);
    if (!asset) throw new Error(`Unknown tribe asset: ${assetId}`);
    if (["candidate", "disabled"].includes(asset.maturity)) throw new Error(`Tribe asset is not executable: ${assetId}`);
    if (!(member.tools ?? []).includes(assetId)) throw new Error(`Member ${member.id} is not authorized to use tribe asset ${assetId}`);
    if (!asset.actions.includes(action)) throw new Error(`Tribe asset ${assetId} does not support action ${action}`);
    return asset;
  }

  async recordUse(input: Omit<ToolAssetUse, "id" | "at">): Promise<ToolAssetUse> {
    const record: ToolAssetUse = { id: crypto.randomUUID(), at: new Date().toISOString(), ...input };
    const operation = this.writeQueue.then(async () => {
      const usage = await this.loadUsage();
      usage.push(record);
      await atomicWrite(this.usagePath, usage.slice(-500));
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return record;
  }

  private async loadCatalog(): Promise<AssetCatalog> {
    const catalog = JSON.parse(await readFile(this.catalogPath, "utf8")) as AssetCatalog;
    if (catalog.schema_version !== 1 || !Array.isArray(catalog.assets)) throw new Error("Invalid tribe asset catalog");
    return catalog;
  }

  private async loadUsage(): Promise<ToolAssetUse[]> {
    try { return JSON.parse(await readFile(this.usagePath, "utf8")) as ToolAssetUse[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async loadWorkflowEvidence() {
    let files: string[];
    try { files = (await readdir(this.proposalsDir)).filter((file) => file.endsWith(".json")); }
    catch { return []; }
    const evidence = await Promise.all(files.map(async (file) => {
      try {
        const workflow = JSON.parse(await readFile(join(this.proposalsDir, file), "utf8")) as {
          id: string; status: string; specialist_member_id: string; updated_at: string;
          mode?: string; commit_sha?: string; issue_url?: string; pr_url?: string;
        };
        if (workflow.status !== "completed") return undefined;
        return {
          workflow_id: workflow.id,
          member_id: workflow.specialist_member_id,
          mode: workflow.mode ?? "commit",
          commit_sha: workflow.commit_sha,
          issue_url: workflow.issue_url,
          pr_url: workflow.pr_url,
          verified_at: workflow.updated_at,
        };
      } catch { return undefined; }
    }));
    return evidence.filter((item) => item !== undefined)
      .sort((left, right) => right.verified_at.localeCompare(left.verified_at))
      .slice(0, 10);
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
