import type { ParsedCliArguments } from "./cli-arguments";
import type { GatewayFetch } from "./gateway-request";
import { requestGatewayJson } from "./gateway-request";
import { readOperatorToken } from "./operator-token";
import type { TextWriter } from "./run-output";

interface DevelopmentPayload {
  id?: string;
  status?: string;
  summary?: string;
  commit_message?: string;
  files?: string[];
  review?: { outcome?: string };
  commit_sha?: string;
}

export async function runDevelopmentGatewayCommand(
  parsed: ParsedCliArguments,
  stdout: TextWriter,
  request: GatewayFetch,
): Promise<number> {
  const token = process.env.TOTEMORA_OPERATOR_TOKEN ?? readOperatorToken(parsed.dataDir);
  if (!token) throw new Error("TOTEMORA_OPERATOR_TOKEN is required for development commands");
  const action = parsed.command[1];
  let path: string;
  let body: unknown;
  if (action === "prepare") {
    if (!parsed.workplace || !parsed.goal) {
      throw new Error("Usage: totemora development prepare --workplace <id> --goal <text>");
    }
    path = "/api/development/prepare";
    body = { workplace_id: parsed.workplace, goal: parsed.goal };
  } else if (action === "approve") {
    const proposalId = parsed.command[2];
    if (!proposalId) throw new Error("Usage: totemora development approve <proposal_id>");
    path = `/api/development/proposals/${encodeURIComponent(proposalId)}/approve`;
  } else {
    throw new Error("Usage: totemora development <prepare|approve>");
  }
  const payload = await requestGatewayJson<DevelopmentPayload>(
    request,
    `${parsed.gatewayUrl.replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  stdout.write(`Proposal: ${payload.id}\nStatus: ${payload.status}\n`);
  if (payload.summary) stdout.write(`Summary: ${payload.summary}\n`);
  if (payload.commit_message) stdout.write(`Commit: ${payload.commit_message}\n`);
  if (payload.files) stdout.write(`Files: ${payload.files.join(", ")}\n`);
  if (payload.review) stdout.write(`Review: ${payload.review.outcome}\n`);
  if (payload.commit_sha) stdout.write(`SHA: ${payload.commit_sha}\n`);
  return payload.status === "failed" ? 1 : 0;
}
