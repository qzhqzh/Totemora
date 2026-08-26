import type { TaskReport } from "@totemora/core";

import type { GatewayFetch } from "./gateway-request";
import { requestGatewayJson } from "./gateway-request";
import { writeTaskReport, type TextWriter } from "./run-output";

interface GatewayRunJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  error?: string;
  run?: {
    final_report?: TaskReport;
    review_outcome?: string;
    usage?: { calls: number; total_tokens: number };
  };
}

export interface GatewayRunOptions {
  gatewayUrl: string;
  operatorToken: string;
  goal: string;
  workspace?: string;
  workplaceId?: string;
  missionId?: string;
  acceptance: string[];
  chief?: string;
  maxFiles?: number;
  maxContextBytes?: number;
  maxOutputTokens?: number;
  maxMembers?: number;
  maxTotalTokens?: number;
}

export async function runGatewayTask(
  options: GatewayRunOptions,
  stdout: TextWriter,
  request: GatewayFetch,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<number> {
  const baseUrl = options.gatewayUrl.replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${options.operatorToken}`,
    "content-type": "application/json",
  };
  let job = await requestGatewayJson<GatewayRunJob>(request, `${baseUrl}/api/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      goal: options.goal,
      workspace: options.workspace,
      workplace_id: options.workplaceId,
      mission_id: options.missionId,
      acceptance: options.acceptance,
      chief: options.chief,
      max_files: options.maxFiles,
      max_context_bytes: options.maxContextBytes,
      max_output_tokens: options.maxOutputTokens,
      max_members: options.maxMembers,
      max_total_tokens: options.maxTotalTokens,
    }),
  });
  stdout.write(`Gateway Run: ${job.id}\n`);
  let lastProgress = "";
  while (true) {
    const progress = `${job.phase}\u0000${job.message}`;
    if (progress !== lastProgress) {
      stdout.write(`[${job.phase}] ${job.message}\n`);
      lastProgress = progress;
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) break;
    await wait(500);
    job = await requestGatewayJson<GatewayRunJob>(
      request,
      `${baseUrl}/api/runs/${encodeURIComponent(job.id)}`,
      { headers: { authorization: `Bearer ${options.operatorToken}` } },
    );
  }
  if (job.status !== "completed") {
    throw new Error(job.error ?? `Gateway Run ended with status ${job.status}`);
  }
  writeTaskReport(job.run?.final_report, job.id, job.run?.review_outcome, job.run?.usage, stdout);
  return 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
