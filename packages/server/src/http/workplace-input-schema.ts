import { HttpError } from "./http-boundary";
import {
  inputObject,
  optionalEnum,
  optionalStringArray,
  requiredString,
} from "./input-schema";

const REMOTE_PROVIDERS = ["none", "github"] as const;

export interface WorkplaceCreateInput {
  name: string;
  path: string;
}

export interface WorkplacePolicyRouteInput {
  instructions: string;
  validation_commands: string[];
  allowed_commit_types: string[];
  forbidden_paths: string[];
  git_flow?: {
    remote_provider: "none" | "github";
    target_branch: string;
    allow_issue: boolean;
    allow_push: boolean;
    allow_pull_request: boolean;
    allow_merge: boolean;
    allow_opencode_fix: boolean;
  };
}

export function workplaceCreateInput(value: unknown): WorkplaceCreateInput {
  const input = inputObject(value);
  return {
    name: requiredString(input.name, "name", 200),
    path: requiredString(input.path, "path", 4_096),
  };
}

export function workplacePolicyInput(value: unknown): WorkplacePolicyRouteInput {
  const input = inputObject(value);
  return {
    instructions: requiredString(input.instructions, "instructions", 20_000),
    validation_commands: optionalStringArray(input.validation_commands, "validation_commands", 50, 1_000) ?? [],
    allowed_commit_types: optionalStringArray(input.allowed_commit_types, "allowed_commit_types", 30, 64) ?? [],
    forbidden_paths: optionalStringArray(input.forbidden_paths, "forbidden_paths", 100, 4_096) ?? [],
    git_flow: gitFlowInput(input.git_flow),
  };
}

function gitFlowInput(value: unknown): WorkplacePolicyRouteInput["git_flow"] {
  if (value === undefined || value === null) return undefined;
  const input = inputObject(value, "git_flow");
  const remoteProvider = optionalEnum(input.remote_provider, "git_flow.remote_provider", REMOTE_PROVIDERS);
  if (!remoteProvider) {
    throw new HttpError(400, `git_flow.remote_provider must be one of ${REMOTE_PROVIDERS.join(", ")}`);
  }
  return {
    remote_provider: remoteProvider,
    target_branch: requiredString(input.target_branch, "git_flow.target_branch", 256),
    allow_issue: requiredBoolean(input.allow_issue, "git_flow.allow_issue"),
    allow_push: requiredBoolean(input.allow_push, "git_flow.allow_push"),
    allow_pull_request: requiredBoolean(input.allow_pull_request, "git_flow.allow_pull_request"),
    allow_merge: requiredBoolean(input.allow_merge, "git_flow.allow_merge"),
    allow_opencode_fix: requiredBoolean(input.allow_opencode_fix, "git_flow.allow_opencode_fix"),
  };
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}
