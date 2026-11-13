const ACCESS_BLOCKED_PREFIX = "Deals source access blocked: ";

// The stable prefix preserves this classification in the existing source-run error ledger.
export class DealSourceAccessBlockedError extends Error {
  constructor(reason: string) {
    super(`${ACCESS_BLOCKED_PREFIX}${reason}`);
    this.name = "DealSourceAccessBlockedError";
  }
}

export function isDealSourceAccessBlocked(error: string | undefined): boolean {
  return error?.startsWith(ACCESS_BLOCKED_PREFIX) ?? false;
}

export function dealRetryAfter(attempts: number, failedAt: string): string {
  const minutes = Math.min(60, 5 * (2 ** Math.min(4, Math.max(0, attempts - 1))));
  return new Date(Date.parse(failedAt) + minutes * 60_000).toISOString();
}
