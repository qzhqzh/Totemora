import { readGatewayResponseText } from "./bounded-response";

export interface TotemoraGatewayClientOptions {
  gatewayUrl: string;
  operatorToken: string;
  fetch?: typeof fetch;
}

export interface DevelopmentProposalSummary {
  id: string;
  status: string;
  workplace_id: string;
  workplace_name: string;
  goal: string;
  mode: "commit" | "pull_request" | "merge";
  issue_mode: "auto" | "none";
  created_at: string;
  snapshot_hash: string;
  policy_version: number;
  specialist_member_id: string;
  assignment_reason: string;
  skill: { id: string; version: number; digest?: string; package_digest?: string; commission_id?: string };
  git_context: {
    branch: string;
    has_develop: boolean;
    unpushed_commits: number;
    stash_count: number;
  };
  files: string[];
  summary: string;
  commit_message: string;
  risk: string;
  validation_commands: string[];
  self_check: { outcome: string; rationale: string; issues: string[] };
  chief_acceptance: { outcome: string; rationale: string; issues: string[] };
  remote_plan?: { target_branch: string; branch_name: string; issue_title?: string; issue_body?: string; pr_title: string; pr_body: string };
  commit_sha?: string;
  issue_number?: number;
  issue_url?: string;
  pr_number?: number;
  pr_url?: string;
  pr_review?: { outcome: string; rationale: string; issues: string[] };
  chief_report?: { summary: string; acceptance: string; evidence: string[] };
  workflow_authorization?: {
    mode: "commit" | "pull_request" | "merge";
    snapshot_hash: string;
    commit_message: string;
    files: string[];
    target_branch?: string;
    approved_at: string;
  };
  error?: string;
}

export interface DevelopmentTaskSummary {
  id: string;
  kind: "git_flow";
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  workplace_id: string;
  goal: string;
  mode: "commit" | "pull_request" | "merge";
  issue_mode: "auto" | "none";
  proposal_id?: string;
  result?: DevelopmentProposalSummary;
  error?: string;
  retryable?: boolean;
}

export class TotemoraGatewayClient {
  private readonly gatewayUrl: string;
  private readonly requestImpl: typeof fetch;

  constructor(private readonly options: TotemoraGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, "");
    this.requestImpl = options.fetch ?? fetch;
  }

  async status() {
    const [status, tribe] = await Promise.all([
      this.request("/api/status"),
      this.request("/api/tribe"),
    ]);
    return { status, tribe };
  }

  async listWorkplaces() {
    return this.request("/api/settlement");
  }

  async listAssets() {
    return this.request("/api/assets");
  }

  async listServices() {
    return this.request("/api/services");
  }

  async listSkillCommissions() {
    return this.request("/api/skills/commissions");
  }

  async createSkillCommission(message: string) {
    return this.request("/api/skills/commissions", {
      method: "POST", body: JSON.stringify({ message }),
    });
  }

  async getSkillCommission(commissionId: string) {
    return this.request(`/api/skills/commissions/${encodeURIComponent(commissionId)}`);
  }

  async continueSkillCommission(commissionId: string, message: string) {
    return this.request(`/api/skills/commissions/${encodeURIComponent(commissionId)}/messages`, {
      method: "POST", body: JSON.stringify({ message }),
    });
  }

  async getSpecialistTask(taskId: string) {
    return this.request(`/api/service-tasks/${encodeURIComponent(taskId)}`);
  }

  async listMemberDossiers() {
    return this.request("/api/members/dossiers");
  }

  async getMemberDossier(memberId: string) {
    return this.request(`/api/members/${encodeURIComponent(memberId)}`);
  }

  async chatWithMember(memberId: string, message: string, askMentor: boolean) {
    return this.request(`/api/members/${encodeURIComponent(memberId)}/chat`, {
      method: "POST", body: JSON.stringify({ message, ask_mentor: askMentor }),
    });
  }

  async listIntelligenceBriefs() {
    return this.request("/api/intelligence");
  }

  async listIntelligenceCandidates() {
    return this.request("/api/intelligence/candidates");
  }

  async listFinanceBriefs() {
    return this.request("/api/finance");
  }

  async listFinanceCandidates() {
    return this.request("/api/finance/candidates");
  }

  async listFinanceSources() {
    return this.request("/api/finance/sources");
  }

  async listActions() {
    return this.request("/api/actions");
  }

  async runIntelligenceBrief(messageCount: number, idempotencyKey?: string, deliveryMode: "candidate_pool" | "direct_push" = "candidate_pool") {
    return this.request("/api/intelligence/tasks", {
      method: "POST", body: JSON.stringify({ message_count: messageCount, idempotency_key: idempotencyKey, delivery_mode: deliveryMode }),
    });
  }

  async getIntelligenceTask(taskId: string) {
    return this.request(`/api/intelligence/tasks/${encodeURIComponent(taskId)}`);
  }

  async runFinanceBrief(messageCount: number, idempotencyKey?: string, deliveryMode: "candidate_pool" | "direct_push" = "candidate_pool") {
    return this.request("/api/finance/tasks", {
      method: "POST", body: JSON.stringify({ message_count: messageCount, idempotency_key: idempotencyKey, delivery_mode: deliveryMode }),
    });
  }

  async getFinanceTask(taskId: string) {
    return this.request(`/api/finance/tasks/${encodeURIComponent(taskId)}`);
  }

  async startGitFlow(
    workplaceId: string,
    goal: string,
    mode: "commit" | "pull_request" | "merge",
    issueMode: "auto" | "none",
  ): Promise<DevelopmentTaskSummary> {
    return this.request("/api/development/tasks", {
      method: "POST",
      body: JSON.stringify({ workplace_id: workplaceId, goal, mode, issue_mode: issueMode }),
    }) as Promise<DevelopmentTaskSummary>;
  }

  async getDevelopmentTask(taskId: string): Promise<DevelopmentTaskSummary> {
    return this.request(`/api/development/tasks/${encodeURIComponent(taskId)}`) as Promise<DevelopmentTaskSummary>;
  }

  async listGitCommitProposals(): Promise<DevelopmentProposalSummary[]> {
    const result = await this.request("/api/development/proposals") as { proposals: DevelopmentProposalSummary[] };
    return result.proposals;
  }

  async getGitCommitProposal(proposalId: string): Promise<DevelopmentProposalSummary> {
    return this.request(`/api/development/proposals/${encodeURIComponent(proposalId)}`) as Promise<DevelopmentProposalSummary>;
  }

  async advanceGitFlow(proposalId: string, gate: "workflow" | "local" | "remote" | "merge"): Promise<DevelopmentProposalSummary> {
    return this.request(`/api/development/proposals/${encodeURIComponent(proposalId)}/advance`, {
      method: "POST",
      body: JSON.stringify({ gate }),
    }) as Promise<DevelopmentProposalSummary>;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.requestImpl(`${this.gatewayUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.operatorToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const raw = await readGatewayResponseText(response);
    let payload: { error?: string };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as { error?: string };
    } catch {
      throw new Error(`Totemora Gateway returned invalid JSON (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(payload.error ?? `Totemora Gateway request failed (${response.status})`);
    }
    return payload;
  }
}
