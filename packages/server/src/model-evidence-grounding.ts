export interface ModelEvidenceReference {
  id: number;
  url: string;
}

export interface ModelEvidenceItem {
  evidence_id?: number;
  url: string;
}

export interface EvidenceGroundingResult<T> {
  items: T[];
  corrected: number;
  invalid: T[];
}

export function groundEvidenceUrls<T extends ModelEvidenceItem>(
  items: T[],
  references: ModelEvidenceReference[],
  additionalAllowedUrls: Iterable<string> = [],
): EvidenceGroundingResult<T> {
  const byId = new Map(references.map((reference) => [reference.id, reference.url]));
  const allowed = new Set([
    ...references.map((reference) => reference.url),
    ...additionalAllowedUrls,
  ]);
  const grounded: T[] = [];
  const invalid: T[] = [];
  let corrected = 0;

  for (const item of items) {
    if (item.evidence_id !== undefined) {
      const expected = byId.get(item.evidence_id);
      if (!expected) {
        invalid.push(item);
        continue;
      }
      if (allowed.has(item.url) && item.url !== expected) {
        invalid.push(item);
        continue;
      }
      if (item.url !== expected) corrected += 1;
      grounded.push({ ...item, url: expected });
      continue;
    }
    if (allowed.has(item.url)) grounded.push(item);
    else invalid.push(item);
  }

  return { items: grounded, corrected, invalid };
}

export function optionalEvidenceId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
