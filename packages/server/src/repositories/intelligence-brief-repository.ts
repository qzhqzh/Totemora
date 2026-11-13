import type { StateDatabase } from "../state-database";

const NAMESPACES = { ai: "intelligence_briefs", finance: "finance_intelligence_briefs" } as const;

/** Read selected briefs without materializing or decoding the complete history. */
export class IntelligenceBriefRepository {
  constructor(private readonly state: Pick<StateDatabase, "db">) {}

  listLatest<T>(domain: "ai" | "finance", limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Intelligence brief limit must be an integer from 1 to 100");
    }
    const rows = this.state.db.query(`
      SELECT payload_json FROM records WHERE namespace=?
      ORDER BY created_at DESC,updated_at DESC LIMIT ?
    `).all(NAMESPACES[domain], limit) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as T);
  }
}
