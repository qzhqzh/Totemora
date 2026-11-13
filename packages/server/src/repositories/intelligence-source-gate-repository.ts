import type { IntelligenceDomain } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";

export interface IntelligenceSourceGateAggregate {
  scans: number;
  collected: number;
  out_of_scope: number;
  history_suppressed: number;
  model_evaluated: number;
  avoided: number;
}

/** Full-history read model; only scalar totals cross the SQLite/JavaScript boundary. */
export class IntelligenceSourceGateRepository {
  private readonly state: StateDatabase;
  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  aggregate(domain: IntelligenceDomain): IntelligenceSourceGateAggregate {
    const namespace = domain === "ai" ? "intelligence_briefs" : "finance_intelligence_briefs";
    return this.state.db.query(`
      SELECT COUNT(*) scans,
        COALESCE(SUM(json_extract(payload_json,'$.source_gate.collected')),0) collected,
        COALESCE(SUM(json_extract(payload_json,'$.source_gate.out_of_scope')),0) out_of_scope,
        COALESCE(SUM(json_extract(payload_json,'$.source_gate.history_suppressed')),0) history_suppressed,
        COALESCE(SUM(json_extract(payload_json,'$.source_gate.model_evaluated')),0) model_evaluated,
        COALESCE(SUM(CASE WHEN json_type(payload_json,'$.source_gate.model_evaluated') IN ('integer','real')
          AND json_extract(payload_json,'$.source_gate.model_evaluated')=0
          AND json_extract(payload_json,'$.source_gate.history_suppressed')>0 THEN 1 ELSE 0 END),0) avoided
      FROM records WHERE namespace=?
    `).get(namespace) as IntelligenceSourceGateAggregate;
  }
}
