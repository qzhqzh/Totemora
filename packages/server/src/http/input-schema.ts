import { HttpError } from "./http-boundary";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function inputObject(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  label: string,
  maximum = 8_000,
  { trim = true }: { trim?: boolean } = {},
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new HttpError(400, `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return trim ? value.trim() : value;
}

export function optionalString(
  value: unknown,
  label: string,
  maximum = 8_000,
  options: { trim?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "") return options.allowEmpty ? "" : undefined;
  return requiredString(value, label, maximum, options);
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

export function optionalNumber(
  value: unknown,
  label: string,
  { minimum, maximum, integer = false }: { minimum?: number; maximum?: number; integer?: boolean } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))
    || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    throw new HttpError(400, `${label} must be a valid${integer ? " integer" : " number"}`);
  }
  return value;
}

export function optionalStringArray(
  value: unknown,
  label: string,
  maximumItems = 100,
  maximumLength = 500,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new HttpError(400, `${label} must contain at most ${maximumItems} strings`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`, maximumLength));
}

export function optionalEnum<const T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new HttpError(400, `${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}
