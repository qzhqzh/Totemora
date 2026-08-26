import type { AgentConfig } from "../config";
import { analyzeTribeTask } from "./task-analyzer";
import type { StaffingPlan, TribeTask } from "./types";

export function validateStaffingPlan(
  plan: StaffingPlan,
  members: ReadonlyMap<string, AgentConfig>,
  chiefId: string,
  minimumAssignments: number,
  maxMembers?: number,
): void {
  if (plan.assignments.length === 0) {
    throw new Error("Chief produced an empty staffing plan");
  }
  const assignmentIds = new Set<string>();
  for (const assignment of plan.assignments) {
    if (!members.has(assignment.member_id)) {
      throw new Error(`Chief assigned unknown member: ${assignment.member_id}`);
    }
    const assignedMember = members.get(assignment.member_id);
    if (assignedMember?.status === "inactive" || assignedMember?.status === "retired") {
      throw new Error(`Chief assigned unavailable member: ${assignment.member_id}`);
    }
    if (assignment.member_id === chiefId) {
      throw new Error("Chief must delegate this onboarding task to other members");
    }
    if (assignmentIds.has(assignment.id)) {
      throw new Error(`Duplicate assignment id: ${assignment.id}`);
    }
    assignmentIds.add(assignment.id);
  }
  if (plan.assignments.length < minimumAssignments) {
    throw new Error(`Chief must delegate this task to at least ${minimumAssignments} member(s)`);
  }
  const selectedMembers = new Set(plan.assignments.map((item) => item.member_id));
  if (maxMembers !== undefined && selectedMembers.size > maxMembers) {
    throw new Error(`Staffing plan exceeds max_members budget: ${selectedMembers.size} > ${maxMembers}`);
  }
}

export function addStaffingEvidence(
  plan: StaffingPlan,
  task: TribeTask,
  members: ReadonlyMap<string, AgentConfig>,
  chiefId: string,
): StaffingPlan {
  const required = analyzeTribeTask(task).required_capabilities;
  const selected = new Set(plan.assignments.map((item) => item.member_id));
  plan.candidate_ranking = [...members.values()]
    .filter((member) => member.id !== chiefId && member.status !== "inactive" && member.status !== "retired")
    .map((member) => {
      const scores = required
        .map((capability) => member.profile[capability as keyof typeof member.profile])
        .filter((score): score is number => score !== undefined);
      const capabilityMatch = scores.length
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : 0;
      const history = task.member_performance?.[member.id];
      const historicalAcceptance = history?.runs ? history.acceptance_rate : null;
      const costEfficiency = member.profile.cost ?? 0.5;
      const score = capabilityMatch * 0.7 + (historicalAcceptance ?? 0.5) * 0.2 + costEfficiency * 0.1;
      return {
        member_id: member.id,
        score: Math.round(score * 1000) / 1000,
        capability_match: Math.round(capabilityMatch * 1000) / 1000,
        historical_acceptance: historicalAcceptance,
        cost_efficiency: costEfficiency,
        selected: selected.has(member.id),
        reason: selected.has(member.id)
          ? "Chief selected this member; Runtime recorded comparative evidence"
          : "Candidate retained for comparison but not selected by Chief",
      };
    })
    .sort((left, right) => right.score - left.score);
  for (const assignment of plan.assignments) {
    const profile = members.get(assignment.member_id)?.profile ?? {};
    const scores = required
      .map((capability) => profile[capability as keyof typeof profile])
      .filter((score): score is number => score !== undefined);
    assignment.selection_score = scores.length
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000
      : 0;
    assignment.cost_efficiency = profile.cost ?? 0.5;
  }
  return plan;
}
