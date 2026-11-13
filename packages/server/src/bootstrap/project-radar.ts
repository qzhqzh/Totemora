import type { DecisionProvider, LocalConfigSet } from "@totemora/core";
import type { NotifierClient } from "@totemora/notifier/client";
import { ProjectRadarService } from "../application/project-radar-service";
import type { ToolAssetRegistry } from "../tool-asset-registry";

export function createProjectRadar(input: {
  dataDir: string; provider?: DecisionProvider; model?: string;
  getConfig(): Promise<LocalConfigSet>; getAssets(): ToolAssetRegistry;
  notifier: Pick<NotifierClient, "dispatch" | "listTargets">;
  publicBaseUrl?: string;
}) {
  const authorize = async (delivery: boolean) => {
    const member = (await input.getConfig()).agents.agents.find((item) => item.id === "qwen_intelligence");
    if (!member || ["inactive", "retired"].includes(member.status ?? "active")) throw new Error("Active intelligence member is required");
    const assets = input.getAssets();
    await assets.assertCanUse(member, "news-intelligence", "summarize");
    if (delivery) {
      await assets.assertCanUse(member, "news-intelligence", "push_bark");
      const targets = await input.notifier.listTargets();
      if (targets.some((target) => target.enabled && target.domains.includes("ai") && target.channel === "telegram")) {
        await assets.assertCanUse(member, "news-intelligence", "push_telegram");
        await assets.assertCanUse(member, "telegram-bot", "push_notification");
      }
    }
  };
  return new ProjectRadarService({
    dataDir: input.dataDir, provider: input.provider, model: input.model, dispatcher: input.notifier,
    publicBaseUrl: input.publicBaseUrl,
    authorizeEvaluation: () => authorize(false), authorizeDelivery: () => authorize(true),
  });
}
