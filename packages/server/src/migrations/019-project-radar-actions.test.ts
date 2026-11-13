import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyProjectRadarActionsMigration } from "./019-project-radar-actions";

import { applyInitialStateMigration } from "./001-initial-state";
import { applyIntelligenceDomainMigration } from "./002-intelligence-domain";
import { applySkillCommissionMigration } from "./003-skill-commission";
import { applySkillCommissionRevisionMigration } from "./004-skill-commission-revision";
import { applySkillTrialRunLeaseMigration } from "./005-skill-trial-run-lease";
import { applySkillTrialLeaseFencingMigration } from "./006-skill-trial-lease-fencing";
import { applyGitFlowSkillIdMigration } from "./007-git-flow-skill-id";
import { applySkillTrialOutcomeMigration } from "./008-skill-trial-outcome";
import { applyCodexSupervisorMigration } from "./009-codex-supervisor";
import { applyCodexThreadHistoryModeMigration } from "./010-codex-thread-history-mode";
import { applyCodexScheduledSubscriptionsMigration } from "./011-codex-scheduled-subscriptions";
import { applyReminderDomainMigration } from "./012-reminder-domain";
import { applyDealsDomainMigration } from "./013-deals-domain";
import { applyForwardedRelayMigration } from "./014-forwarded-relay";
import { applyLegacyIntelligenceEvidenceMigration } from "./015-legacy-intelligence-evidence";
import { applyNotificationIngressMigration } from "./016-notification-ingress";
import { applyProjectRadarMigration } from "./017-project-radar";
import { applyProjectRadarDigestsMigration } from "./018-project-radar-digests";

const timestamp = "2026-10-25T10:00:00.000Z";
const evidence = JSON.stringify([{ title: "Original", url: "https://example.com/item", source: "official", excerpt: "Original material" }]);
const criteria = JSON.stringify(["检查原文", "记录结论"]);
function insert(db: Database, patch: Record<string, unknown> = {}) {
  const values = { id: "action-1", candidate_id: "candidate-1", evaluation_id: "evaluation-1", project_id: "echome",
    project_name: "EchoMe", project_goal: "记忆检索", title: "核实原文", rationale: "项目相关", next_step: "建议核实原文",
    acceptance_criteria_json: criteria, evidence_json: evidence, method: "rules", status: "proposed", created_at: timestamp,
    decided_at: null, decision_source: null, ...patch };
  return db.query(`INSERT INTO project_radar_actions(${Object.keys(values).join(",")}) VALUES(${Object.keys(values).map(() => "?").join(",")})`)
    .run(...Object.values(values) as Array<string | null>);
}

test("migration 19 preserves pre-upgrade data, creates bounded action state and repeats safely", () => {
  const db = version18Fixture();
  try {
    applyProjectRadarActionsMigration(db); applyProjectRadarActionsMigration(db);
    expect(db.query("SELECT id,status FROM intelligence_candidates ORDER BY id").all()).toEqual([
      { id: "candidate-1", status: "queued" }, { id: "candidate-2", status: "pushed" }]);
    expect(db.query("SELECT payload_json FROM records").get()).toEqual({ payload_json: '{"keep":true}' });
    expect(db.query("SELECT COUNT(*) count FROM schema_migrations WHERE version=19").get()).toEqual({ count: 1 });
    insert(db);
    expect(db.query("SELECT candidate_id,evaluation_id,project_id,status FROM project_radar_actions").get()).toEqual({
      candidate_id: "candidate-1", evaluation_id: "evaluation-1", project_id: "echome", status: "proposed" });
    expect(() => insert(db, { id: "duplicate" })).toThrow();
    expect(() => insert(db, { id: "wrong-evaluation", project_id: "other", evaluation_id: "evaluation-2" })).toThrow();
    expect(() => insert(db, { id: "missing", project_id: "other", candidate_id: "missing" })).toThrow();
  } finally { db.close(); }
});

test("database constraints reject invalid enums, missing fields, malformed evidence and incoherent decisions", () => {
  const db = version18Fixture();
  try {
    applyProjectRadarActionsMigration(db);
    for (const patch of [{ status: "executed" }, { method: "model-magic" }, { status: "accepted" },
      { decision_source: "web" }, { decided_at: timestamp }, { status: "dismissed", decided_at: timestamp, decision_source: "cron" },
      { title: "" }, { title: "x".repeat(601) }, { evidence_json: "{}" }, { evidence_json: "[]" },
      { evidence_json: "invalid" }, { evidence_json: JSON.stringify([{ url: "https://example.com" }]) },
      { acceptance_criteria_json: "[]" }, { acceptance_criteria_json: "{}" }, { acceptance_criteria_json: "[1]" },
      { acceptance_criteria_json: JSON.stringify(["x".repeat(1501)]) }]) expect(() => insert(db, patch)).toThrow();
    insert(db, { status: "accepted", decided_at: timestamp, decision_source: "telegram" });
    expect(db.query("SELECT status FROM project_radar_actions").get()).toEqual({ status: "accepted" });
    expect(() => db.query("UPDATE project_radar_actions SET title='silently changed'").run()).toThrow();
    expect(() => db.query("UPDATE project_radar_actions SET status='dismissed'").run()).toThrow();
  } finally { db.close(); }
});

test("decision receipts enforce action references, body identity and a bounded matching result", () => {
  const db = version18Fixture();
  try {
    applyProjectRadarActionsMigration(db); insert(db, { status: "accepted", decided_at: timestamp, decision_source: "web" });
    const result = JSON.stringify({ id: "action-1", status: "accepted" });
    const query = db.query(`INSERT INTO project_radar_action_decisions(idempotency_key,action_id,decision,source,request_fingerprint,result_json,created_at)
      VALUES(?,?,?,?,?,?,?)`);
    query.run("decision-1", "action-1", "accept", "web", "a".repeat(64), result, timestamp);
    for (const args of [
      ["decision-1", "action-1", "accept", "web", "a".repeat(64), result, timestamp],
      ["decision-2", "missing", "accept", "web", "a".repeat(64), result, timestamp],
      ["decision-2", "action-1", "execute", "web", "a".repeat(64), result, timestamp],
      ["decision-2", "action-1", "accept", "cron", "a".repeat(64), result, timestamp],
      ["decision-2", "action-1", "accept", "web", "a".repeat(64), "{}", timestamp],
      ["decision-2", "action-1", "dismiss", "web", "a".repeat(64), result, timestamp],
    ]) expect(() => query.run(...args)).toThrow();
  } finally { db.close(); }
});

test("migration 19 rolls back all DDL and version registration after a failure", () => {
  const db = version18Fixture();
  try {
    db.exec("CREATE TRIGGER reject_19 BEFORE INSERT ON schema_migrations WHEN NEW.version=19 BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    expect(() => applyProjectRadarActionsMigration(db)).toThrow("fixture rollback");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'project_radar_action%' OR name='project_radar_evaluation_candidate'").all()).toEqual([]);
    expect(db.query("SELECT version FROM schema_migrations WHERE version=19").get()).toBeNull();
    expect(db.query("SELECT COUNT(*) count FROM project_radar_evaluations").get()).toEqual({ count: 2 });
    db.exec("DROP TRIGGER reject_19"); applyProjectRadarActionsMigration(db); insert(db);
    expect(db.query("SELECT COUNT(*) count FROM project_radar_actions").get()).toEqual({ count: 1 });
  } finally { db.close(); }
});

function version18Fixture(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  // Frozen v1–v18 migrations build the actual schema used before the action feature.
  const priorMigrations = [
    applyInitialStateMigration, applyIntelligenceDomainMigration, applySkillCommissionMigration,
    applySkillCommissionRevisionMigration, applySkillTrialRunLeaseMigration, applySkillTrialLeaseFencingMigration,
    applyGitFlowSkillIdMigration, applySkillTrialOutcomeMigration, applyCodexSupervisorMigration,
    applyCodexThreadHistoryModeMigration, applyCodexScheduledSubscriptionsMigration, applyReminderDomainMigration,
    applyDealsDomainMigration, applyForwardedRelayMigration, applyLegacyIntelligenceEvidenceMigration,
    applyNotificationIngressMigration, applyProjectRadarMigration, applyProjectRadarDigestsMigration,
  ];
  for (const migrate of priorMigrations) migrate(db);
  for (const [id, status] of [["candidate-1", "queued"], ["candidate-2", "pushed"]]) {
    db.query(`INSERT INTO intelligence_candidates(id,scan_id,member_id,event_key,headline,brief,url,source,
      importance,interest,confidence,novelty,base_total,total,rationale,is_update,status,decision,created_at,updated_at)
      VALUES(?,'scan','member',?,'Original headline','Generated summary','https://example.com/item','official',
        0.9,0.9,0.9,0.9,0.9,0.9,'supported',0,?,'eligible',?,?)`).run(id, id, status, timestamp, timestamp);
    const evaluationId = id.replace("candidate", "evaluation");
    const evaluation = { id: evaluationId, candidate_id: id, baseline: { scores: { importance: 0.9, interest: 0.9, confidence: 0.9,
      novelty: 0.9, base_total: 0.9, feedback_adjustment: 0, total: 0.9 }, status }, projects: [{ project_id: "echome", relevance: 0.9, confidence: 0.9 }],
      decision_confidence: 0.9, evidence_quality: 0.9, novelty: 0.9, urgency: 0.5, route: "digest", reason: "项目相关",
      model: "jev-test", question_version: "project-radar-v1", settings_fingerprint: "a".repeat(64), input_fingerprint: "b".repeat(64), created_at: timestamp };
    db.query(`INSERT INTO project_radar_evaluations(id,candidate_id,route,settings_fingerprint,input_fingerprint,evaluation_json,created_at)
      VALUES(?,?,'digest',?,?,?,?)`).run(evaluationId, id, evaluation.settings_fingerprint, evaluation.input_fingerprint, JSON.stringify(evaluation), timestamp);
  }
  db.query("INSERT INTO records VALUES('fixture','old-record',?,?,?)").run('{"keep":true}', timestamp, timestamp);
  return db;
}
