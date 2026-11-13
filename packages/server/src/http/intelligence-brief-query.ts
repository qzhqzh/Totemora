import { HttpError } from "./http-boundary";

export function intelligenceBriefLimit(url: URL): number | undefined {
  const values = url.searchParams.getAll("limit");
  if (!values.length) return undefined;
  if (values.length !== 1) throw new HttpError(400, "limit must be provided only once");
  const value = values[0]!;
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "limit must be an integer from 1 to 100");
  }
  return limit;
}
