import type { DevelopmentProposal } from "./development-service";
import { assertSafePath, escapeRegExp } from "./development-git-client";
import type { WorkplacePolicy } from "./settlement-store";

export interface SpecialistOutput {
  summary: string;
  commit_message: string;
  files: string[];
  risk: string;
  validation_commands: string[];
  experience_used: string[];
  skill_improvement?: string;
  self_check: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] };
  remote_plan?: {
    target_branch: string;
    branch_name: string;
    issue_title?: string;
    issue_body?: string;
    pr_title: string;
    pr_body: string;
  };
}

export function validateSpecialistOutput(
  output: SpecialistOutput,
  snapshotFiles: string[],
  policy: WorkplacePolicy,
  availableExperienceIds: Set<string>,
  mode: DevelopmentProposal["mode"],
): void {
  if (!output || !output.summary || !output.commit_message || !output.risk
    || !Array.isArray(output.files) || !Array.isArray(output.validation_commands)
    || !Array.isArray(output.experience_used)) {
    throw new Error("Commit specialist returned an invalid proposal");
  }
  validateAcceptance(output.self_check, "Git Flow specialist self-check");
  if (output.self_check.outcome !== "accepted") throw new Error("Git Flow specialist rejected its own plan");
  if (mode !== "commit" && (!output.remote_plan?.target_branch || !output.remote_plan.branch_name
    || !output.remote_plan.pr_title || !output.remote_plan.pr_body)) {
    throw new Error("Git Flow specialist returned an incomplete remote plan");
  }
  if (mode !== "commit" && output.remote_plan?.target_branch !== policy.git_flow?.target_branch) {
    throw new Error("Git Flow specialist selected a target branch outside Workplace Policy");
  }
  if (output.remote_plan?.branch_name
    && !/^(feat|fix|test|chore|docs|refactor|codex)\/[a-z0-9._/-]+$/.test(output.remote_plan.branch_name)) {
    throw new Error("Git Flow specialist selected an invalid working branch name");
  }
  if (output.skill_improvement !== undefined && typeof output.skill_improvement !== "string") {
    throw new Error("Commit specialist returned an invalid Skill improvement");
  }
  if (!output.files.length || output.files.some((file) => !snapshotFiles.includes(file))) {
    throw new Error("Commit specialist selected files outside the Git Snapshot");
  }
  if (output.validation_commands.some((command) => !policy.validation_commands.includes(command))) {
    throw new Error("Commit specialist selected a validation command outside Workplace Policy");
  }
  if (output.experience_used.some((id) => !availableExperienceIds.has(id))) {
    throw new Error("Commit specialist referenced an unknown experience");
  }
  const allowed = policy.allowed_commit_types.map(escapeRegExp).join("|");
  if (!new RegExp(`^(${allowed})(\\([a-z0-9._/-]+\\))?: .{1,72}$`).test(output.commit_message)) {
    throw new Error(`Commit message ${JSON.stringify(output.commit_message)} does not satisfy Policy; expected type(scope optional): subject with type in [${policy.allowed_commit_types.join(", ")}] and a 1-72 character subject`);
  }
  for (const file of output.files) assertSafePath(file, policy);
}

export function validateAcceptance(
  value: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] } | undefined,
  owner: string,
): asserts value is { outcome: "accepted" | "rejected"; rationale: string; issues: string[] } {
  if (!value || !["accepted", "rejected"].includes(value.outcome)
    || !value.rationale || !Array.isArray(value.issues)) {
    throw new Error(`${owner} returned an invalid acceptance`);
  }
}

export function validatePrReview(
  value: DevelopmentProposal["pr_review"],
): asserts value is NonNullable<DevelopmentProposal["pr_review"]> {
  if (!value || !["accepted", "changes_requested"].includes(value.outcome)
    || !value.rationale || !Array.isArray(value.issues)) {
    throw new Error("Git Flow specialist returned an invalid PR review");
  }
}

export function validateChiefReport(
  value: DevelopmentProposal["chief_report"],
): asserts value is NonNullable<DevelopmentProposal["chief_report"]> {
  if (!value || !value.summary || !["passed", "failed"].includes(value.acceptance)
    || !Array.isArray(value.evidence)) {
    throw new Error("Chief returned an invalid final Git Flow report");
  }
}

export function parseMemberJson(content: string, memberId: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try { return JSON.parse(fenced.trim()); }
      catch { /* Try balanced extraction. */ }
    }
    for (const candidate of balancedJsonObjects(content)) {
      try { return JSON.parse(candidate); }
      catch { /* Keep scanning. */ }
    }
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`Member ${memberId} returned invalid JSON for development workflow: ${preview || "empty response"}`);
  }
}

function balancedJsonObjects(content: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        values.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return values;
}
