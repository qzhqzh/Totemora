import { inputObject, optionalNumber, optionalString, optionalStringArray, requiredString } from "./input-schema";

export interface RunRouteInput {
  goal: string;
  workspace?: string;
  workplace_id?: string;
  mission_id?: string;
  acceptance?: string[];
  chief?: string;
  max_files?: number;
  max_context_bytes?: number;
  max_output_tokens?: number;
  max_members?: number;
  max_total_tokens?: number;
  mission_context?: string[];
}

export interface IntakeAnalysisInput {
  goal: string;
  workspace?: string;
  workplace_id?: string;
  mission_id?: string;
}

export interface MissionCreateInput {
  title: string;
  workplace_id?: string;
}

export function runRequestInput(value: unknown): RunRouteInput {
  const input = inputObject(value);
  return {
    goal: requiredString(input.goal, "goal", 8_000),
    workspace: optionalString(input.workspace, "workspace", 4_096),
    workplace_id: optionalString(input.workplace_id, "workplace_id", 256),
    mission_id: optionalString(input.mission_id, "mission_id", 256),
    acceptance: optionalStringArray(input.acceptance, "acceptance", 50, 1_000),
    chief: optionalString(input.chief, "chief", 256),
    max_files: optionalInteger(input.max_files, "max_files", 1, 10_000),
    max_context_bytes: optionalInteger(input.max_context_bytes, "max_context_bytes", 1_000, 20_000_000),
    max_output_tokens: optionalInteger(input.max_output_tokens, "max_output_tokens", 100, 200_000),
    max_members: optionalInteger(input.max_members, "max_members", 1, 100),
    max_total_tokens: optionalInteger(input.max_total_tokens, "max_total_tokens", 1_000, 10_000_000),
  };
}

export function intakeAnalysisInput(value: unknown): IntakeAnalysisInput {
  const input = inputObject(value);
  return {
    goal: requiredString(input.goal, "goal", 8_000),
    workspace: optionalString(input.workspace, "workspace", 4_096),
    workplace_id: optionalString(input.workplace_id, "workplace_id", 256),
    mission_id: optionalString(input.mission_id, "mission_id", 256),
  };
}

export function missionCreateInput(value: unknown): MissionCreateInput {
  const input = inputObject(value);
  return {
    title: requiredString(input.title, "title", 500),
    workplace_id: optionalString(input.workplace_id, "workplace_id", 256),
  };
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  return optionalNumber(value, label, { minimum, maximum, integer: true });
}
