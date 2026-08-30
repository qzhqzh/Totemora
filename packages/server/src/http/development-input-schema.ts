import { HttpError } from "./http-boundary";
import { inputObject, optionalEnum, optionalString, requiredString } from "./input-schema";

const DEVELOPMENT_MODES = ["commit", "pull_request", "merge"] as const;
const ISSUE_MODES = ["auto", "none"] as const;
const DEVELOPMENT_GATES = ["workflow", "local", "remote", "merge"] as const;

export interface DevelopmentRequestInput {
  workplace_id: string;
  goal: string;
  mode?: "commit" | "pull_request" | "merge";
  issue_mode?: "auto" | "none";
  trial_commission_id?: string;
}

export type DevelopmentGate = "workflow" | "local" | "remote" | "merge";

export function developmentRequestInput(value: unknown): DevelopmentRequestInput {
  const input = inputObject(value);
  return {
    workplace_id: requiredString(input.workplace_id, "workplace_id", 256),
    goal: requiredString(input.goal, "goal", 8_000),
    mode: optionalEnum(input.mode, "mode", DEVELOPMENT_MODES),
    issue_mode: optionalEnum(input.issue_mode, "issue_mode", ISSUE_MODES),
    trial_commission_id: optionalString(input.trial_commission_id, "trial_commission_id", 256),
  };
}

export function developmentGateInput(value: unknown): DevelopmentGate {
  const input = inputObject(value);
  const gate = optionalEnum(input.gate, "gate", DEVELOPMENT_GATES);
  if (!gate) throw new HttpError(400, `gate must be one of ${DEVELOPMENT_GATES.join(", ")}`);
  return gate;
}
