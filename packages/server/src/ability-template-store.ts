import { StateDatabase } from "./state-database";

export type AbilityTemplateKind = "prompt" | "workflow";

interface AbilityTemplateBase {
  id: string;
  name: string;
  summary: string;
  revision: number;
  updated_at: string;
}

export interface PromptTemplate extends AbilityTemplateBase {
  kind: "prompt";
  category: string;
  role: string;
  model: string;
  variables: string[];
  content: string;
}

export interface WorkflowTemplateStep {
  name: string;
  actor: string;
  desc: string;
}

export interface WorkflowTemplate extends AbilityTemplateBase {
  kind: "workflow";
  trigger: string;
  steps: WorkflowTemplateStep[];
}

export type AbilityTemplate = PromptTemplate | WorkflowTemplate;

interface StoredTemplate {
  kind: AbilityTemplateKind;
  id: string;
  deleted: boolean;
  template?: AbilityTemplate;
  updated_at: string;
}

const NAMESPACE = "ability_templates";
const DEFAULT_UPDATED_AT = "2026-08-23T00:00:00.000Z";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const DEFAULT_TEMPLATES: AbilityTemplate[] = [
  prompt({
    id: "chief-task-router",
    name: "首领任务路由与选人决策",
    category: "task",
    role: "chief",
    model: "deepseek/deepseek-v4-pro",
    summary: "分析任务复杂度、安全边界与预算约束，并在部落成员中完成能力匹配和选人排班。",
    variables: ["goal", "workspace", "budget", "acceptance_criteria"],
    content: `你是 Totemora 部落的首领（Chief）。你的职责是全面理解任务目标，评估输入输出边界与安全级别，并在可用成员中挑选最胜任的成员分派任务。

## 决策规则
1. 识别任务模式：只读分析（inspect）、代码变更（change）、情报巡查（watch）、内容创作（content）。
2. 在预算和上下文窗口约束下，优先选择通过历史验收的专员。
3. 产出结构化的成员指派（Assignment）与验收标准（Acceptance Plan）。`,
  }),
  prompt({
    id: "git-flow-reviewer",
    name: "Git Flow 变更审核与自检",
    category: "system",
    role: "specialist",
    model: "deepseek/deepseek-v4-pro",
    summary: "负责检查工作树改动，执行确定性校验命令，确保符合分支模型与 Conventional Commits 规范。",
    variables: ["git_status", "diff", "branch_model", "validation_commands"],
    content: `你是 Totemora 的 Git 流程专员（Git Steward）。你负责在受限工作地内拟定变更提交计划。

## 核心规范
- 严格遵循仓库分支模型（mainline 模式或 develop 模式）。
- 不顺手重构未要求的代码，保留用户已有工作区改动。
- 生成规范的 Conventional Commit 提交信息。
- 提供自检证据，确保所有验证命令全部通过。`,
  }),
  prompt({
    id: "content-duo-writer",
    name: "创作者工坊选题与双人撰写",
    category: "persona",
    role: "writer",
    model: "qwen/qwen-2.5-72b",
    summary: "结合听风采集的情报与用户选题，撰写结构严密、可读性强、含实操指引的技术文章或热点解读。",
    variables: ["topic", "source_candidate", "format", "target_audience"],
    content: `你是 Totemora 创作者工坊的执笔成员。

## 创作原则
- 事实严谨：核心论点均引用真实来源或代码事实。
- 结构清晰：采用总-分-总或教程步骤式推进，提供完整上下文。
- 拒绝套话：直击技术本质与业务价值，输出可直接采纳复制的成果。`,
  }),
  prompt({
    id: "finance-market-brief",
    name: "观潮财经研报结构化提炼",
    category: "task",
    role: "analyst",
    model: "qwen/qwen-2.5-72b",
    summary: "从多源行情、宏观政策与权威公告中提炼市场异动归因与高价值情报简报。",
    variables: ["market_sources", "watchlist", "novelty_window", "macro_events"],
    content: `你是 Totemora 观潮台的财经情报分析员。

## 提炼原则
- 结构化提取：时间、标的、事件性质、影响范围、核心数据指标。
- 新颖度去重：过滤 168 小时内的重复或泛化噪音。
- 风险提示：对不确定市场信息标记置信度与证据来源。`,
  }),
  prompt({
    id: "cpa-visual-director",
    name: "绘影视觉配图策划与提示词构建",
    category: "persona",
    role: "illustrator",
    model: "cpa/flux-pro",
    summary: "将文章核心意象与技术概念转化为风格一致的高质量视觉提示词与线稿构图。",
    variables: ["article_title", "article_summary", "visual_style", "aspect_ratio"],
    content: `你是 Totemora 创作者工坊的绘影视觉策划。

## 视觉原则
- 意象契合：提炼文章核心技术图腾与概念隐喻。
- 画面构图：保持暗黑科技与部落图腾融合的克制美学。
- 提示词构建：精确描述主体、光影、构图与负向排查。`,
  }),
  workflow({
    id: "git-flow-pipeline",
    name: "Git 变更提交与安全 PR 流水线",
    trigger: "任务大厅发起或代码提交请求",
    summary: "从工作区分析到本地提交、自检、首领验收，经操作员门禁后推送到 GitHub/Gitea 并创建 PR。",
    steps: [
      ["工作区分析与模式识别", "Chief", "分析 diff 改动范围与工作地 Policy 约束"],
      ["编制提交计划与命令自检", "Git Steward", "生成 Conventional Commit 信息并运行验证命令"],
      ["首领双重验收", "Chief", "独立核对验证输出与改动范围，确认无越界修改"],
      ["操作员门禁确认", "Operator", "人工授权执行 Git Commit / Push / PR / Merge"],
      ["证据归档与经历演进", "Observatory", "记录 SHA 与产物证据，更新参与成员能力画像"],
    ],
  }),
  workflow({
    id: "content-duo-studio",
    name: "创作者工坊双人协作内容管线",
    trigger: "情报候选采纳或用户手动选题",
    summary: "听风选题调研 → 千工执笔初稿 → 绘影生成配图 → 双盲交叉审校 → 形成可复制作品案卷。",
    steps: [
      ["选题与背景调研", "听风 (Researcher)", "搜集权威背景材料与技术线索"],
      ["正文起草与结构化排版", "千工 (Writer)", "撰写教程长文或热点短帖正文"],
      ["视觉配图策划与生成", "绘影 (Illustrator)", "构建配图简报并调用 CPA 模型生成配图"],
      ["独立审校与打分", "Reviewer", "校验事实一致性、代码可运行性与配图语义契合度"],
      ["案卷入库与采纳追踪", "Studio Dossier", "生成作品版本，记录用户复制与采纳信号"],
    ],
  }),
  workflow({
    id: "intelligence-watch-cycle",
    name: "60s 全局常驻巡查与情报萃取流",
    trigger: "后台 RecurringServiceRunner 调度器每 60 秒触发",
    summary: "自动巡查 AI 与财经权威来源，经价值漏斗与去重打分后推送到 Bark 移动设备与情报台。",
    steps: [
      ["权威源线索采集", "Watch Runner", "定时轮询官方披露、市场媒体与技术资讯"],
      ["文本清洗与语义去重", "Intelligence Dispatcher", "对比 168 小时历史候选池，剔除冗余相似消息"],
      ["多维价值漏斗评分", "Score Engine", "评估置信度、技术突破性与业务相关度"],
      ["结构化摘要生成", "Analyst Member", "提炼标题要点并生成事实证据"],
      ["多路由设备推送", "Bark Service", "根据用户偏好阈值推送到不同通道的 Bark 设备"],
    ],
  }),
];

export class AbilityTemplateInputError extends Error {}
export class AbilityTemplateNotFoundError extends Error {}

export class AbilityTemplateStore {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  list(): { prompts: PromptTemplate[]; workflows: WorkflowTemplate[] } {
    const overrides = new Map(this.state.listRecords<StoredTemplate>(NAMESPACE)
      .map((item) => [`${item.kind}:${item.id}`, item]));
    const templates = DEFAULT_TEMPLATES.flatMap((item) => {
      const stored = overrides.get(`${item.kind}:${item.id}`);
      overrides.delete(`${item.kind}:${item.id}`);
      if (stored?.deleted) return [];
      return [stored?.template ?? structuredClone(item)];
    });
    for (const stored of overrides.values()) {
      if (!stored.deleted && stored.template) templates.push(stored.template);
    }
    return {
      prompts: templates.filter((item): item is PromptTemplate => item.kind === "prompt")
        .sort((left, right) => left.id.localeCompare(right.id)),
      workflows: templates.filter((item): item is WorkflowTemplate => item.kind === "workflow")
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  update(kind: "prompt", id: string, input: unknown): PromptTemplate;
  update(kind: "workflow", id: string, input: unknown): WorkflowTemplate;
  update(kind: AbilityTemplateKind, id: string, input: unknown): AbilityTemplate;
  update(kind: AbilityTemplateKind, id: string, input: unknown): AbilityTemplate {
    assertId(id);
    const current = this.find(kind, id);
    if (!current) throw new AbilityTemplateNotFoundError("Ability template not found");
    const now = new Date().toISOString();
    const template = kind === "prompt"
      ? parsePrompt(id, input, current.revision + 1, now)
      : parseWorkflow(id, input, current.revision + 1, now);
    this.save({ kind, id, deleted: false, template, updated_at: now });
    return template;
  }

  delete(kind: AbilityTemplateKind, id: string): void {
    assertId(id);
    if (!this.find(kind, id)) throw new AbilityTemplateNotFoundError("Ability template not found");
    this.save({ kind, id, deleted: true, updated_at: new Date().toISOString() });
  }

  private find(kind: AbilityTemplateKind, id: string): AbilityTemplate | undefined {
    const values = this.list();
    return (kind === "prompt" ? values.prompts : values.workflows).find((item) => item.id === id);
  }

  private save(value: StoredTemplate): void {
    this.state.putRecord(NAMESPACE, `${value.kind}:${value.id}`, value, value.updated_at, value.updated_at);
  }
}

function prompt(input: Omit<PromptTemplate, "kind" | "revision" | "updated_at">): PromptTemplate {
  return { kind: "prompt", revision: 1, updated_at: DEFAULT_UPDATED_AT, ...input };
}

function workflow(input: Omit<WorkflowTemplate, "kind" | "revision" | "updated_at" | "steps"> & {
  steps: Array<[string, string, string]>;
}): WorkflowTemplate {
  return {
    kind: "workflow", revision: 1, updated_at: DEFAULT_UPDATED_AT, ...input,
    steps: input.steps.map(([name, actor, desc]) => ({ name, actor, desc })),
  };
}

function parsePrompt(id: string, input: unknown, revision: number, updatedAt: string): PromptTemplate {
  const value = object(input);
  return {
    kind: "prompt", id, revision, updated_at: updatedAt,
    name: text(value.name, "name", 120),
    category: text(value.category, "category", 40),
    role: text(value.role, "role", 80),
    model: text(value.model, "model", 160),
    summary: text(value.summary, "summary", 500),
    variables: stringList(value.variables, "variables", 20, 80),
    content: text(value.content, "content", 20_000),
  };
}

function parseWorkflow(id: string, input: unknown, revision: number, updatedAt: string): WorkflowTemplate {
  const value = object(input);
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 20) {
    throw new AbilityTemplateInputError("steps must contain 1-20 entries");
  }
  return {
    kind: "workflow", id, revision, updated_at: updatedAt,
    name: text(value.name, "name", 120),
    trigger: text(value.trigger, "trigger", 500),
    summary: text(value.summary, "summary", 500),
    steps: value.steps.map((item, index) => {
      const step = object(item, `steps[${index}]`);
      return {
        name: text(step.name, `steps[${index}].name`, 120),
        actor: text(step.actor, `steps[${index}].actor`, 120),
        desc: text(step.desc, `steps[${index}].desc`, 500),
      };
    }),
  };
}

function object(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AbilityTemplateInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new AbilityTemplateInputError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new AbilityTemplateInputError(`${label} must contain at most ${maximumItems} strings`);
  }
  return value.map((item, index) => text(item, `${label}[${index}]`, maximumLength));
}

function assertId(value: string): void {
  if (!SAFE_ID.test(value)) throw new AbilityTemplateInputError("Invalid ability template id");
}
