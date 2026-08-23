import {
  SkillCommissionConflictError,
  SkillCommissionService,
  type SkillTrial,
} from "../skill-commission-service";
import {
  SkillTrialConflictError,
  SkillTrialInputError,
  SkillTrialRunnerService,
  type SkillTrialRunInput,
} from "../skill-trial-runner-service";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalEnum, optionalString, requiredString } from "./input-schema";

interface SkillCommissionServices {
  skills: SkillCommissionService;
  skillTrials: SkillTrialRunnerService;
}

interface SkillCommissionRouteDependencies {
  getServices(): Promise<SkillCommissionServices>;
  requireOperator(request: Request): void;
}

export async function handleSkillCommissionRoutes(
  request: Request,
  url: URL,
  dependencies: SkillCommissionRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/skills/commissions")
    && !url.pathname.startsWith("/api/skills/trial-runs")) return undefined;

  dependencies.requireOperator(request);
  const services = await dependencies.getServices();

  if (request.method === "GET" && url.pathname === "/api/skills/commissions") {
    return json({ commissions: services.skills.list() });
  }
  if (request.method === "POST" && url.pathname === "/api/skills/commissions") {
    const input = inputObject(await readJson(request, 16_000));
    return json(await translate(() => services.skills.create(requiredString(input.message, "message"))), 201);
  }
  if (request.method === "GET" && url.pathname === "/api/skills/trial-runs") {
    return json({ runs: services.skillTrials.list(url.searchParams.get("commission_id") ?? undefined) });
  }

  const runDetail = url.pathname.match(/^\/api\/skills\/trial-runs\/([^/]+)$/);
  if (request.method === "GET" && runDetail) {
    const run = services.skillTrials.get(runDetail[1]!);
    return run ? json(run) : json({ error: "Skill trial run not found" }, 404);
  }

  const messages = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/messages$/);
  if (request.method === "POST" && messages) {
    const input = inputObject(await readJson(request, 16_000));
    return json(await translate(() => services.skills.addMessage(
      messages[1]!, requiredString(input.message, "message"),
    )));
  }

  const validate = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/validate$/);
  if (request.method === "POST" && validate) {
    return json(await translate(() => services.skills.validate(validate[1]!)));
  }

  const trial = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/trials$/);
  if (request.method === "POST" && trial) {
    const input = trialEvidenceInput(await readJson(request, 16_000));
    return json(await translate(() => services.skills.recordTrial(trial[1]!, input)), 201);
  }

  const runTrial = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/run-trial$/);
  if (request.method === "POST" && runTrial) {
    const input = trialRunInput(await readJson(request, 16_000));
    try {
      return json(services.skillTrials.start(runTrial[1]!, input), 202);
    } catch (error) {
      if (error instanceof SkillTrialInputError || error instanceof SkillTrialConflictError) throw error;
      const reference = crypto.randomUUID().slice(0, 8);
      console.error(JSON.stringify({ event: "skill_trial_start_failed", reference, error: message(error) }));
      return json({ error: "Unable to start Skill trial", reference }, 500);
    }
  }

  const proposal = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/propose-activation$/);
  if (request.method === "POST" && proposal) {
    return json(await translate(() => services.skills.proposeActivation(proposal[1]!)));
  }

  const activation = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/activate$/);
  if (request.method === "POST" && activation) {
    const input = inputObject(await readJson(request, 4_000));
    const approvedBy = optionalString(input.approved_by, "approved_by", 160) ?? "operator";
    return json(await translate(() => services.skills.activate(activation[1]!, approvedBy)));
  }

  const rollback = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/rollback$/);
  if (request.method === "POST" && rollback) {
    const input = inputObject(await readJson(request, 4_000));
    const reviewedBy = optionalString(input.reviewed_by, "reviewed_by", 160) ?? "operator";
    return json(await translate(() => services.skills.rollback(rollback[1]!, reviewedBy)));
  }

  const cancel = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancel) {
    return json(await translate(() => services.skills.cancel(cancel[1]!)));
  }

  const commission = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)$/);
  if (request.method === "GET" && commission) {
    const result = services.skills.get(commission[1]!);
    return result ? json(result) : json({ error: "Skill commission not found" }, 404);
  }
  return undefined;
}

function trialEvidenceInput(value: unknown): Pick<SkillTrial,
  "baseline_evidence_id" | "trial_evidence_id" | "reviewer_member_id" | "outcome" | "summary"
> {
  const input = inputObject(value);
  const outcome = optionalEnum(input.outcome, "outcome", ["accepted", "rejected"] as const);
  if (!outcome) throw new HttpError(400, "outcome is required");
  return {
    baseline_evidence_id: requiredString(input.baseline_evidence_id, "baseline_evidence_id", 256),
    trial_evidence_id: requiredString(input.trial_evidence_id, "trial_evidence_id", 256),
    reviewer_member_id: requiredString(input.reviewer_member_id, "reviewer_member_id", 160),
    outcome,
    summary: requiredString(input.summary, "summary", 500),
  };
}

function trialRunInput(value: unknown): SkillTrialRunInput {
  const input = inputObject(value);
  const mode = optionalString(input.mode, "mode", 32);
  const issueMode = optionalString(input.issue_mode, "issue_mode", 16);
  if (mode && !["commit", "pull_request", "merge"].includes(mode)) {
    throw new SkillTrialInputError("Invalid Skill trial mode");
  }
  if (issueMode && !["auto", "none"].includes(issueMode)) {
    throw new SkillTrialInputError("Invalid Skill trial issue_mode");
  }
  return {
    idempotency_key: requiredString(input.idempotency_key, "idempotency_key", 128),
    workplace_id: requiredString(input.workplace_id, "workplace_id", 160),
    goal: requiredString(input.goal, "goal", 2_000),
    reviewer_member_id: requiredString(input.reviewer_member_id, "reviewer_member_id", 160),
    mode: mode as SkillTrialRunInput["mode"],
    issue_mode: issueMode as SkillTrialRunInput["issue_mode"],
  };
}

async function translate<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError || error instanceof SkillCommissionConflictError
      || error instanceof SkillTrialInputError || error instanceof SkillTrialConflictError) throw error;
    const detail = message(error);
    if (detail.startsWith("Skill commission not found:")) throw new HttpError(404, detail);
    if (isDomainRejection(detail)) throw new HttpError(409, detail);
    throw error;
  }
}

function isDomainRejection(detail: string): boolean {
  return detail.startsWith("Skill commission cannot")
    || detail.startsWith("Only a draft Skill commission")
    || detail.startsWith("Only an active Skill")
    || detail.startsWith("Skill package ")
    || detail.startsWith("Skill trial ")
    || detail.startsWith("An accepted Skill trial")
    || detail.startsWith("A target member cannot")
    || detail.startsWith("Target member lacks")
    || detail.startsWith("approved_by is required")
    || detail.startsWith("reviewed_by is required");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
