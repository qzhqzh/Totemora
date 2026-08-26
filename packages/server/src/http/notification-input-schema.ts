import type { BarkDomain, BarkTargetMutationInput } from "../bark-notification-service";
import { HttpError } from "./http-boundary";
import {
  inputObject,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./input-schema";

const BARK_DOMAINS = ["ai", "finance"] as const;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function barkTargetInput(value: unknown, pathId?: string): BarkTargetMutationInput {
  const input = inputObject(value);
  const id = pathId ?? requiredString(input.id, "id", 64);
  if (!TARGET_ID.test(id)) {
    throw new HttpError(400, "id must be 1-64 letters, numbers, dots, underscores, or dashes");
  }
  if (id === "primary") throw new HttpError(400, "id primary is reserved for the legacy Bark target");
  const domains = optionalStringArray(input.domains, "domains", 2, 16);
  if (domains?.some((domain) => !BARK_DOMAINS.includes(domain as BarkDomain))) {
    throw new HttpError(400, `domains must contain only ${BARK_DOMAINS.join(", ")}`);
  }
  if (domains?.length === 0) throw new HttpError(400, "domains must contain at least one value");
  const deviceKey = optionalString(input.device_key, "device_key", 512);
  if (!pathId && !deviceKey) throw new HttpError(400, "device_key is required");
  if (deviceKey && /\s|\//.test(deviceKey)) throw new HttpError(400, "device_key is invalid");
  return {
    id,
    label: optionalString(input.label, "label", 80),
    device_key: deviceKey,
    domains: domains as BarkDomain[] | undefined,
    enabled: optionalBoolean(input.enabled, "enabled"),
    server_url: optionalString(input.server_url, "server_url", 2_048),
  };
}

export function barkTestInput(value: unknown): { idempotency_key?: string } {
  const input = inputObject(value);
  return { idempotency_key: optionalString(input.idempotency_key, "idempotency_key", 256) };
}
