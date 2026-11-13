export const FORWARDED_SOURCE_FAILURE_KINDS = [
  "certificate", "tls", "authentication", "configuration", "unavailable", "invalid_response",
] as const;
export type ForwardedSourceFailureKind = typeof FORWARDED_SOURCE_FAILURE_KINDS[number];

export interface ForwardedPollingBackoff {
  consecutive_failures: number;
  failure_kind: ForwardedSourceFailureKind;
  last_failure_at: string;
  next_poll_at: string;
}

const FAILURE_MESSAGES: Record<ForwardedSourceFailureKind, string> = {
  certificate: "Forwarded source TLS certificate verification failed; repair the upstream certificate chain or configure its trusted CA",
  tls: "Forwarded source TLS handshake failed; check the upstream endpoint and network routing",
  authentication: "Forwarded source rejected authentication; check its credentials and topic permissions",
  configuration: "Forwarded source configuration is invalid; check HTTPS URL and owner-only credential file permissions",
  unavailable: "Forwarded source is temporarily unavailable; a later poll will retry automatically",
  invalid_response: "Forwarded source returned an invalid or oversized response; check its ntfy endpoint",
};

export class ForwardedSourceError extends Error {
  constructor(readonly kind: ForwardedSourceFailureKind) {
    super(FAILURE_MESSAGES[kind]);
    this.name = "ForwardedSourceError";
  }
}

export function classifyForwardedSourceError(
  error: unknown,
  fallback: ForwardedSourceFailureKind = "unavailable",
): ForwardedSourceError {
  if (error instanceof ForwardedSourceError) return error;
  let current = error;
  let handshakeFailure = false;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = "code" in current && typeof current.code === "string" ? current.code : "";
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER/i.test(code)
      || /certificate|self.signed|unable to verify.*signature/i.test(current.message)) {
      return new ForwardedSourceError("certificate");
    }
    handshakeFailure ||= /ERR_(SSL|TLS)_|UNEXPECTED_EOF_WHILE_READING/i.test(code)
      || /(TLS|SSL).*(handshake|EOF|disconnect|closed|failed|error)|(?:handshake|EOF|disconnect|closed).*(TLS|SSL)|unexpected eof while reading|EOF occurred in violation of protocol/i.test(current.message);
    current = current.cause;
  }
  return new ForwardedSourceError(handshakeFailure ? "tls" : fallback);
}

export function forwardedRetryDelayMs(attempts: number, kind: ForwardedSourceFailureKind = "unavailable"): number {
  const base = ["certificate", "authentication", "configuration"].includes(kind) ? 30 * 60_000 : 5 * 60_000;
  return Math.min(6 * 60 * 60_000, base * 2 ** Math.min(10, Math.max(0, attempts - 1)));
}

export function forwardedPollingBackoff(
  prior: ForwardedPollingBackoff | undefined,
  kind: ForwardedSourceFailureKind,
  timestamp: string,
): ForwardedPollingBackoff {
  const failures = Math.min(Number.MAX_SAFE_INTEGER, (prior?.consecutive_failures ?? 0) + 1);
  return {
    consecutive_failures: failures,
    failure_kind: kind,
    last_failure_at: timestamp,
    next_poll_at: new Date(Date.parse(timestamp) + forwardedRetryDelayMs(failures, kind)).toISOString(),
  };
}
