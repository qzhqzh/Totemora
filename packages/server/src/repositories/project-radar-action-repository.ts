import { createHash } from "node:crypto";
import { StateDatabase } from "../state-database";
import { parseProjectRadarAction, parseProjectRadarActionDecision, parseProjectRadarActionId,
  ProjectRadarActionConflictError, ProjectRadarActionInputError, ProjectRadarActionNotFoundError,
  type ProjectRadarAction } from "../domains/intelligence/project-radar-action";

type ActionRow = Omit<ProjectRadarAction, "acceptance_criteria" | "evidence"> & { acceptance_criteria_json: string; evidence_json: string };

export class ProjectRadarActionRepository {
  private readonly state: StateDatabase;
  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  list(limit = 100): ProjectRadarAction[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ProjectRadarActionInputError("action limit must be 1–500");
    return (this.state.db.query("SELECT * FROM project_radar_actions ORDER BY created_at DESC,id LIMIT ?").all(limit) as ActionRow[]).map(decode);
  }
  get(id: string): ProjectRadarAction | undefined {
    const row = this.state.db.query("SELECT * FROM project_radar_actions WHERE id=?").get(parseProjectRadarActionId(id)) as ActionRow | null;
    return row ? decode(row) : undefined;
  }
  saveProposal(value: ProjectRadarAction): ProjectRadarAction {
    const action = parseProjectRadarAction(value);
    if (action.status !== "proposed") throw new ProjectRadarActionInputError("new action must be proposed");
    // Preserve the first evidence snapshot, including when later replays change their evaluation.
    this.state.db.query(`INSERT INTO project_radar_actions(id,candidate_id,evaluation_id,project_id,project_name,project_goal,
      title,rationale,next_step,acceptance_criteria_json,evidence_json,method,status,created_at,decided_at,decision_source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,NULL,NULL) ON CONFLICT(candidate_id,project_id) DO NOTHING`)
      .run(action.id, action.candidate_id, action.evaluation_id, action.project_id, action.project_name, action.project_goal,
        action.title, action.rationale, action.next_step, JSON.stringify(action.acceptance_criteria), JSON.stringify(action.evidence), action.method, action.created_at);
    const row = this.state.db.query("SELECT * FROM project_radar_actions WHERE candidate_id=? AND project_id=?")
      .get(action.candidate_id, action.project_id) as ActionRow;
    return decode(row);
  }
  decide(id: string, value: unknown, now = new Date()): ProjectRadarAction {
    const actionId = parseProjectRadarActionId(id);
    const input = parseProjectRadarActionDecision(value);
    const fingerprint = createHash("sha256").update(JSON.stringify({ action_id: actionId, decision: input.decision, source: input.source })).digest("hex");
    return this.state.db.transaction(() => {
      const receipt = this.state.db.query("SELECT request_fingerprint,result_json FROM project_radar_action_decisions WHERE idempotency_key=?")
        .get(input.idempotency_key) as { request_fingerprint: string; result_json: string } | null;
      if (receipt) {
        if (receipt.request_fingerprint !== fingerprint) throw new ProjectRadarActionConflictError("idempotency key already belongs to a different decision request");
        return parseProjectRadarAction(JSON.parse(receipt.result_json));
      }
      const action = this.get(actionId);
      if (!action) throw new ProjectRadarActionNotFoundError("project radar action not found");
      const status = input.decision === "accept" ? "accepted" : "dismissed";
      if (action.status !== "proposed" && action.status !== status) throw new ProjectRadarActionConflictError("action is already decided; the opposite decision is not allowed");
      if (action.status === "proposed") this.state.db.query(`UPDATE project_radar_actions SET status=?,decided_at=?,decision_source=?
        WHERE id=? AND status='proposed'`).run(status, now.toISOString(), input.source, action.id);
      const result = this.get(action.id)!;
      this.state.db.query(`INSERT INTO project_radar_action_decisions(idempotency_key,action_id,decision,source,request_fingerprint,result_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(input.idempotency_key, action.id, input.decision, input.source, fingerprint, JSON.stringify(result), now.toISOString());
      return result;
    }).immediate();
  }
}
function decode(row: ActionRow): ProjectRadarAction {
  const { acceptance_criteria_json, evidence_json, ...action } = row;
  return parseProjectRadarAction({ ...action, acceptance_criteria: JSON.parse(acceptance_criteria_json), evidence: JSON.parse(evidence_json) });
}
