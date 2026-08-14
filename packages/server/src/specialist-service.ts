import { StateDatabase } from "./state-database";

export type SpecialistTaskStatus =
  | "queued" | "routing" | "running" | "waiting_approval" | "waiting_external"
  | "completed" | "failed" | "cancelled";

export interface SpecialistServiceDefinition {
  id: "git.flow" | "intelligence.watch" | "finance.watch" | "content.studio";
  version: number;
  title: string;
  summary: string;
  operations: string[];
  required_capabilities: string[];
  required_assets: string[];
  allowed_assets: string[];
  risk: "read_only" | "external_side_effects" | "repository_mutation";
  acceptance_policy: string;
  stages: string[];
}

export interface SpecialistTask {
  id: string;
  service_id: SpecialistServiceDefinition["id"];
  service_version: number;
  operation: string;
  trigger: "manual" | "scheduled" | "mcp" | "web";
  status: SpecialistTaskStatus;
  current_stage: string;
  revision: number;
  member_id?: string;
  chief_member_id?: string;
  idempotency_key?: string;
  input: unknown;
  result?: unknown;
  result_ref?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  events?: Array<{ seq: number; type: string; actor_id?: string; stage: string; summary: string; at: string }>;
}

export const SPECIALIST_SERVICES: SpecialistServiceDefinition[] = [
  {
    id: "git.flow", version: 1, title: "Git 流程代办",
    summary: "由 Chief 路由给 Git 专员，按工作地规范完成 Commit、Pull Request 或 Merge，并保留自检与验收证据。",
    operations: ["commit", "pull_request", "merge", "skill_trial"],
    required_capabilities: ["git-flow-safety"],
    required_assets: ["git-flow-engine"],
    allowed_assets: ["git-flow-engine", "opencode-correction"],
    risk: "repository_mutation",
    acceptance_policy: "专员自检通过，Chief 核对范围、验证结果和目标门禁；外部动作需要对应授权。",
    stages: ["routing", "inspect", "plan", "baseline", "trial", "review", "evidence", "local_gate", "remote_gate", "merge_gate", "accepted"],
  },
  {
    id: "intelligence.watch", version: 1, title: "听风情报值守",
    summary: "常驻委任情报员按规则扫描来源；候选评估、通知派发和用户反馈分别留下证据。",
    operations: ["scan"],
    required_capabilities: ["news-intelligence"],
    required_assets: ["news-intelligence"],
    allowed_assets: ["news-intelligence", "aihot-public-feed", "internal-bark", "telegram-bot"],
    risk: "external_side_effects",
    acceptance_policy: "扫描只算操作完成；候选获得明确正向反馈或专业任务验收后才形成成长信用。",
    stages: ["collect", "summarize", "candidate_gate", "dispatch", "feedback"],
  },
  {
    id: "finance.watch", version: 1, title: "观潮财经值守",
    summary: "常驻财经情报员按官方披露、监管与宏观来源扫描；市场、自选标的、事件和证据等级进入独立候选门禁。",
    operations: ["scan"],
    required_capabilities: ["financial-intelligence-briefing"],
    required_assets: ["finance-intelligence"],
    allowed_assets: ["finance-intelligence", "official-finance-sources", "internal-bark", "telegram-bot"],
    risk: "external_side_effects",
    acceptance_policy: "扫描只算操作；明确用户正向反馈才形成成长信用。不得生成买卖建议，S2-S4 信息不能替代官方事实证据。",
    stages: ["collect", "source_health", "summarize", "candidate_gate", "dispatch", "feedback"],
  },
  {
    id: "content.studio", version: 1, title: "部落内容工坊",
    summary: "Chief 按常驻委任组织至少两名成员，把情报候选转化为 X 热点短帖或教程长文，并保留研究、写作与审校证据。",
    operations: ["x_hot_post", "longform_tutorial"],
    required_capabilities: ["editorial-research", "structured-writing"],
    required_assets: ["content-studio"],
    allowed_assets: ["content-studio", "news-intelligence", "cpa-image-generation"],
    risk: "external_side_effects",
    acceptance_policy: "至少两名不同成员实际贡献；来源 URL 与事实边界通过独立审校；外部发布始终需要单独授权和幂等回执。",
    stages: ["routing", "research", "draft", "review", "copy_ready", "publish_gate"],
  },
];

interface TaskRow {
  id: string; service_id: SpecialistTask["service_id"]; service_version: number; operation: string;
  trigger: SpecialistTask["trigger"]; status: SpecialistTaskStatus; current_stage: string; revision: number;
  member_id: string | null; chief_member_id: string | null; idempotency_key: string | null;
  input_json: string; result_json: string | null; result_ref: string | null; error: string | null;
  created_at: string; updated_at: string;
}

export class SpecialistTaskRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  registerBinding(input: {
    service_id: SpecialistServiceDefinition["id"];
    chief_member_id: string;
    specialist_member_id: string;
    routing_reason: string;
    capability_evidence: string[];
    tool_grants: string[];
  }): void {
    const definition = requireService(input.service_id);
    this.state.db.query(`
      INSERT INTO service_bindings(
        service_id,service_version,chief_member_id,specialist_member_id,routing_reason,
        capability_evidence_json,tool_grants_json,status,revision,updated_at
      ) VALUES(?,?,?,?,?,?,?,'active',1,?)
      ON CONFLICT(service_id) DO UPDATE SET
        service_version=excluded.service_version,chief_member_id=excluded.chief_member_id,
        specialist_member_id=excluded.specialist_member_id,routing_reason=excluded.routing_reason,
        capability_evidence_json=excluded.capability_evidence_json,
        tool_grants_json=excluded.tool_grants_json,status='active',
        revision=service_bindings.revision+1,updated_at=excluded.updated_at
      WHERE service_bindings.service_version IS NOT excluded.service_version
         OR service_bindings.chief_member_id IS NOT excluded.chief_member_id
         OR service_bindings.specialist_member_id IS NOT excluded.specialist_member_id
         OR service_bindings.routing_reason IS NOT excluded.routing_reason
         OR service_bindings.capability_evidence_json IS NOT excluded.capability_evidence_json
         OR service_bindings.tool_grants_json IS NOT excluded.tool_grants_json
         OR service_bindings.status IS NOT 'active'
    `).run(
      input.service_id, definition.version, input.chief_member_id, input.specialist_member_id,
      input.routing_reason, JSON.stringify(input.capability_evidence), JSON.stringify(input.tool_grants),
      new Date().toISOString(),
    );
  }

  create(input: Omit<SpecialistTask, "revision" | "created_at" | "updated_at">): SpecialistTask {
    const definition = requireService(input.service_id);
    if (!definition.operations.includes(input.operation)) throw new Error(`Unsupported ${input.service_id} operation: ${input.operation}`);
    const now = new Date().toISOString();
    this.state.db.transaction(() => {
      this.state.db.query(`
        INSERT INTO specialist_tasks(
          id,service_id,service_version,operation,trigger,status,current_stage,revision,
          member_id,chief_member_id,idempotency_key,input_json,result_json,result_ref,error,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
      `).run(
        input.id, input.service_id, definition.version, input.operation, input.trigger,
        input.status, input.current_stage, input.member_id ?? null, input.chief_member_id ?? null,
        input.idempotency_key ?? null, JSON.stringify(input.input), input.result ? JSON.stringify(input.result) : null,
        input.result_ref ?? null, input.error ?? null, now, now,
      );
      this.event(input.id, "created", input.current_stage, "专业任务已登记", input.chief_member_id);
    })();
    return this.get(input.id)!;
  }

  update(id: string, expectedRevision: number, patch: {
    status: SpecialistTaskStatus; current_stage: string; result?: unknown;
    result_ref?: string; error?: string; member_id?: string; summary: string; actor_id?: string;
  }): SpecialistTask {
    const now = new Date().toISOString();
    this.state.db.transaction(() => {
      const result = this.state.db.query(`
        UPDATE specialist_tasks
        SET status=?,current_stage=?,result_json=?,result_ref=?,error=?,
            member_id=COALESCE(?,member_id),revision=revision+1,updated_at=?
        WHERE id=? AND revision=?
      `).run(
        patch.status, patch.current_stage, patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.result_ref ?? null, patch.error ?? null, patch.member_id ?? null, now, id, expectedRevision,
      );
      if (result.changes !== 1) throw new Error(`Specialist task revision conflict: ${id}`);
      this.event(id, patch.status, patch.current_stage, patch.summary, patch.actor_id);
    })();
    return this.get(id)!;
  }

  get(id: string): SpecialistTask | undefined {
    const row = this.state.db.query("SELECT * FROM specialist_tasks WHERE id=?").get(id) as TaskRow | null;
    if (!row) return undefined;
    const task = fromRow(row);
    task.events = (this.state.db.query(`
      SELECT seq,type,actor_id,stage,summary,at
      FROM specialist_task_events WHERE task_id=? ORDER BY seq
    `).all(id) as Array<{ seq: number; type: string; actor_id: string | null; stage: string; summary: string; at: string }>)
      .map((event) => ({ ...event, actor_id: event.actor_id ?? undefined }));
    return task;
  }

  list(limit = 100): SpecialistTask[] {
    return (this.state.db.query(`
      SELECT * FROM specialist_tasks ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as TaskRow[]).map(fromRow);
  }

  findByResultRef(serviceId: SpecialistServiceDefinition["id"], resultRef: string): SpecialistTask | undefined {
    const row = this.state.db.query(`
      SELECT * FROM specialist_tasks WHERE service_id=? AND result_ref=?
      ORDER BY updated_at DESC LIMIT 1
    `).get(serviceId, resultRef) as TaskRow | null;
    return row ? fromRow(row) : undefined;
  }

  appendEvent(taskId: string, input: {
    type: "external_receipt" | "user_feedback" | "evidence";
    stage: string;
    summary: string;
    actor_id?: string;
  }): void {
    if (!this.get(taskId)) throw new Error(`Specialist task not found: ${taskId}`);
    this.event(taskId, input.type, input.stage, input.summary, input.actor_id);
  }

  bindings(): unknown[] {
    return (this.state.db.query("SELECT * FROM service_bindings ORDER BY service_id").all() as Array<Record<string, unknown>>)
      .map((row) => ({
        ...row,
        capability_evidence: JSON.parse(String(row.capability_evidence_json)),
        tool_grants: JSON.parse(String(row.tool_grants_json)),
        capability_evidence_json: undefined,
        tool_grants_json: undefined,
      }));
  }

  private event(taskId: string, type: string, stage: string, summary: string, actorId?: string): void {
    this.state.db.query(`
      INSERT INTO specialist_task_events(task_id,seq,type,actor_id,stage,summary,at)
      SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,?
      FROM specialist_task_events WHERE task_id=?
    `).run(taskId, type, actorId ?? null, stage, summary, new Date().toISOString(), taskId);
  }
}

export function requireService(id: string): SpecialistServiceDefinition {
  const definition = SPECIALIST_SERVICES.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown specialist service: ${id}`);
  return definition;
}

function fromRow(row: TaskRow): SpecialistTask {
  return {
    id: row.id, service_id: row.service_id, service_version: row.service_version,
    operation: row.operation, trigger: row.trigger, status: row.status,
    current_stage: row.current_stage, revision: row.revision,
    member_id: row.member_id ?? undefined, chief_member_id: row.chief_member_id ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined, input: JSON.parse(row.input_json),
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    result_ref: row.result_ref ?? undefined, error: row.error ?? undefined,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
