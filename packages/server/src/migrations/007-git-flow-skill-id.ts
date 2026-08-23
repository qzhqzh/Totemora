import { createHash } from "node:crypto";

import {
  GIT_FLOW_SKILL_ID,
  GIT_FLOW_SKILL_VERSION,
  LEGACY_GIT_FLOW_SKILL_ID,
  LEGACY_GIT_FLOW_SKILL_VERSION,
} from "../git-flow-skill";
import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyGitFlowSkillIdMigration: StateMigration = (db) => {
  if (hasMigration(db, 7)) return;
  db.transaction(() => {
    const oldId = LEGACY_GIT_FLOW_SKILL_ID;
    const newId = GIT_FLOW_SKILL_ID;
    const migratePackage = (value: Record<string, unknown>): {
      value: Record<string, unknown>;
      superseded: boolean;
    } => {
      if (value.skill_id !== oldId) return { value, superseded: false };
      const staleBase = typeof value.base_version !== "number"
        || value.base_version < GIT_FLOW_SKILL_VERSION;
      const superseded = staleBase && ["draft", "validated", "active"].includes(String(value.status));
      const migrated: Record<string, unknown> = {
        ...value,
        skill_id: newId,
        skill_md: typeof value.skill_md === "string"
          ? value.skill_md.replace(/^name: git-change-management$/m, `name: ${newId}`)
          : value.skill_md,
        ...(superseded ? { status: "superseded" } : {}),
      };
      const normalized = { ...migrated, digest: undefined, status: undefined };
      migrated.digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      return { value: migrated, superseded };
    };

    const commissions = db.query(`
      SELECT id,package_json FROM skill_commissions WHERE package_json IS NOT NULL
    `).all() as Array<{ id: string; package_json: string }>;
    for (const row of commissions) {
      const migrated = migratePackage(JSON.parse(row.package_json) as Record<string, unknown>);
      if (migrated.value.skill_id === newId) {
        db.query(`
          UPDATE skill_commissions SET package_json=?,package_digest=?,
            status=CASE WHEN ?=1 AND status NOT IN ('cancelled','suspended','superseded')
              THEN 'superseded' ELSE status END
          WHERE id=?
        `).run(JSON.stringify(migrated.value), String(migrated.value.digest), migrated.superseded ? 1 : 0, row.id);
      }
    }

    const activations = db.query(`
      SELECT id,package_json FROM skill_activations WHERE skill_id=?
    `).all(oldId) as Array<{ id: string; package_json: string }>;
    for (const row of activations) {
      const migrated = migratePackage(JSON.parse(row.package_json) as Record<string, unknown>);
      db.query(`
        UPDATE skill_activations SET skill_id=?,package_json=?,digest=?,
          status=CASE WHEN ?=1 AND status='active' THEN 'superseded' ELSE status END
        WHERE id=?
      `).run(
        newId, JSON.stringify(migrated.value), String(migrated.value.digest),
        migrated.superseded ? 1 : 0, row.id,
      );
    }

    const records = db.query(`
      SELECT namespace,id,payload_json,created_at,updated_at FROM records
      WHERE namespace IN ('skill_overlays','skill_proposals')
    `).all() as Array<{
      namespace: string;
      id: string;
      payload_json: string;
      created_at: string;
      updated_at: string;
    }>;
    for (const row of records) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (payload.skill_id !== oldId) continue;
      payload.skill_id = newId;
      if (row.namespace === "skill_overlays") {
        const additions = Array.isArray(payload.additions) ? payload.additions : [];
        const previousBase = typeof payload.base_version === "number"
          ? payload.base_version
          : LEGACY_GIT_FLOW_SKILL_VERSION;
        const previousVersion = typeof payload.version === "number"
          ? payload.version
          : previousBase + additions.length;
        const versionDelta = Math.max(0, GIT_FLOW_SKILL_VERSION - previousBase);
        payload.base_version = GIT_FLOW_SKILL_VERSION;
        payload.version = Math.max(
          GIT_FLOW_SKILL_VERSION + additions.length,
          previousVersion + versionDelta,
        );
      } else if (row.namespace === "skill_proposals" && typeof payload.base_version === "number") {
        payload.base_version += GIT_FLOW_SKILL_VERSION - LEGACY_GIT_FLOW_SKILL_VERSION;
      }
      const id = row.namespace === "skill_overlays" && row.id === oldId ? newId : row.id;
      db.query(`
        INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(namespace,id) DO UPDATE SET
          payload_json=excluded.payload_json,updated_at=excluded.updated_at
      `).run(row.namespace, id, JSON.stringify(payload), row.created_at, row.updated_at);
      if (id !== row.id) db.query("DELETE FROM records WHERE namespace=? AND id=?").run(row.namespace, row.id);
    }
    recordMigration(db, 7, "rename git flow Skill canonical id");
  })();
};
