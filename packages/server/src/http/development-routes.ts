import type { DevelopmentCommitService, DevelopmentProposal } from "../development-service";
import { HttpError, json, readJson } from "./http-boundary";
import {
  developmentGateInput,
  developmentRequestInput,
  type DevelopmentRequestInput,
} from "./development-input-schema";
import { requiredString } from "./input-schema";

export type DevelopmentRouteService = Pick<DevelopmentCommitService,
  "prepare" | "listProposals" | "listSkillProposals" | "approveSkillProposal"
  | "getProposal" | "complete" | "approve" | "publish" | "merge"
>;

export interface DevelopmentTaskView {
  created_at: string;
}

export interface DevelopmentRouteDependencies {
  getDevelopment(): Promise<DevelopmentRouteService>;
  enqueueTask(input: DevelopmentRequestInput): Promise<unknown>;
  listTasks(): DevelopmentTaskView[];
  getTask(id: string): DevelopmentTaskView | undefined;
  syncSpecialistTask(proposal: DevelopmentProposal): void;
  requireOperator(request: Request): void;
}

export async function handleDevelopmentRoutes(
  request: Request,
  url: URL,
  dependencies: DevelopmentRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/development")) return undefined;

  if (request.method === "POST" && url.pathname === "/api/development/prepare") {
    dependencies.requireOperator(request);
    const input = developmentRequestInput(await readJson(request, 16_000));
    const service = await dependencies.getDevelopment();
    return json(await translate(() => service.prepare(input.workplace_id, input.goal, {
      mode: input.mode,
      issue_mode: input.issue_mode,
      trial_commission_id: input.trial_commission_id,
    })), 201);
  }
  if (request.method === "POST" && url.pathname === "/api/development/tasks") {
    dependencies.requireOperator(request);
    return json(await dependencies.enqueueTask(
      developmentRequestInput(await readJson(request, 16_000)),
    ), 202);
  }
  if (request.method === "GET" && url.pathname === "/api/development/tasks") {
    dependencies.requireOperator(request);
    return json({ tasks: dependencies.listTasks()
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 50) });
  }

  const taskMatch = url.pathname.match(/^\/api\/development\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    dependencies.requireOperator(request);
    const task = dependencies.getTask(decodePathSegment(taskMatch[1]!, "task id"));
    return task ? json(task) : json({ error: "Development task not found" }, 404);
  }

  if (request.method === "GET" && url.pathname === "/api/development/proposals") {
    dependencies.requireOperator(request);
    return json({ proposals: await (await dependencies.getDevelopment()).listProposals() });
  }
  if (request.method === "GET" && url.pathname === "/api/development/skill-proposals") {
    dependencies.requireOperator(request);
    return json({ proposals: await (await dependencies.getDevelopment()).listSkillProposals() });
  }

  const skillApproval = url.pathname.match(/^\/api\/development\/skill-proposals\/([^/]+)\/approve$/);
  if (request.method === "POST" && skillApproval) {
    dependencies.requireOperator(request);
    const proposalId = decodePathSegment(skillApproval[1]!, "Skill proposal id");
    return json(await translate(() => dependencies.getDevelopment()
      .then((service) => service.approveSkillProposal(proposalId))));
  }

  const proposalMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)$/);
  if (request.method === "GET" && proposalMatch) {
    dependencies.requireOperator(request);
    const proposalId = decodePathSegment(proposalMatch[1]!, "proposal id");
    return json(await translate(() => dependencies.getDevelopment()
      .then((service) => service.getProposal(proposalId))));
  }

  const approveMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    dependencies.requireOperator(request);
    const proposalId = decodePathSegment(approveMatch[1]!, "proposal id");
    const proposal = await translate(() => dependencies.getDevelopment()
      .then((service) => service.approve(proposalId)));
    dependencies.syncSpecialistTask(proposal);
    return json(proposal);
  }

  const advanceMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)\/advance$/);
  if (request.method === "POST" && advanceMatch) {
    dependencies.requireOperator(request);
    const proposalId = decodePathSegment(advanceMatch[1]!, "proposal id");
    const gate = developmentGateInput(await readJson(request, 8_000));
    const service = await dependencies.getDevelopment();
    const proposal = await translate(() => gate === "workflow" ? service.complete(proposalId)
      : gate === "local" ? service.approve(proposalId)
      : gate === "remote" ? service.publish(proposalId) : service.merge(proposalId));
    dependencies.syncSpecialistTask(proposal);
    return json(proposal);
  }
  return undefined;
}

function decodePathSegment(value: string, label: string): string {
  try { return requiredString(decodeURIComponent(value), label, 256); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `${label} is not valid URL encoding`);
  }
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("Development proposal not found:")
      || detail.startsWith("Skill proposal not found:") || detail === "工作地不存在") {
      throw new HttpError(404, detail);
    }
    if (detail.startsWith("Proposal cannot execute from status")
      || detail.startsWith("Git Flow remote stage cannot execute from")
      || detail.startsWith("Git Flow merge stage cannot execute from")
      || detail.startsWith("Git Flow workflow cannot execute from")
      || detail.startsWith("Git Flow workflow authorization no longer matches")
      || detail.startsWith("Skill proposal cannot be approved from")
      || detail.startsWith("Skill changed after this proposal")
      || detail.startsWith("Workplace Policy changed")
      || detail.startsWith("Git working tree changed")
      || detail === "工作地尚未安装开发提交规范") {
      throw new HttpError(409, detail);
    }
    throw error;
  }
}
