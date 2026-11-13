import { StateDatabase } from "./state-database";

export interface ResearchDirection {
  id: string;
  name: string;
  keywords: string[];
  enabled: boolean;
}

export interface ResearchDirectionSet {
  directions: ResearchDirection[];
  updated_at: string;
}

const NAMESPACE = "research-directions";
const RECORD_ID = "active";
export const MAX_RESEARCH_DIRECTIONS = 24;
export const MAX_RESEARCH_KEYWORDS_PER_DIRECTION = 8;
export const MAX_RESEARCH_KEYWORD_CHARACTERS = 1_200;
const EMPTY_SET: ResearchDirectionSet = { directions: [], updated_at: new Date(0).toISOString() };

export class ResearchDirectionStore {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  async get(): Promise<ResearchDirectionSet> {
    const stored = this.state.listRecords<ResearchDirectionSet>(NAMESPACE)[0];
    return stored ? validate(stored) : structuredClone(EMPTY_SET);
  }

  async save(input: unknown): Promise<ResearchDirectionSet> {
    const value = validate(input);
    value.updated_at = new Date().toISOString();
    this.state.putRecord(NAMESPACE, RECORD_ID, value, value.updated_at, value.updated_at);
    return value;
  }
}

function validate(input: unknown): ResearchDirectionSet {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Research direction set must be an object");
  }
  const rawDirections = (input as { directions?: unknown }).directions;
  if (!Array.isArray(rawDirections) || rawDirections.length > MAX_RESEARCH_DIRECTIONS) {
    throw new Error(`Research direction set must contain at most ${MAX_RESEARCH_DIRECTIONS} directions`);
  }
  const ids = new Set<string>();
  let keywordCharacters = 0;
  const directions = rawDirections.map((raw, index): ResearchDirection => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Research direction ${index + 1} must be an object`);
    }
    const value = raw as Partial<ResearchDirection>;
    const id = cleanText(value.id, 64, `Research direction ${index + 1} id`).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`Research direction ${index + 1} id must use lowercase letters, numbers, and hyphens`);
    }
    if (ids.has(id)) throw new Error(`Research direction id is duplicated: ${id}`);
    ids.add(id);
    const name = cleanText(value.name, 80, `Research direction ${id} name`);
    if (!Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > MAX_RESEARCH_KEYWORDS_PER_DIRECTION) {
      throw new Error(`Research direction ${id} must contain 1-${MAX_RESEARCH_KEYWORDS_PER_DIRECTION} keywords`);
    }
    const keywords = [...new Set(value.keywords.map((keyword) => cleanText(
      keyword, 100, `Research direction ${id} keyword`,
    )))];
    keywordCharacters += keywords.reduce((total, keyword) => total + keyword.length, 0);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new Error(`Research direction ${id} enabled must be a boolean`);
    }
    return { id, name, keywords, enabled: value.enabled !== false };
  });
  if (keywordCharacters > MAX_RESEARCH_KEYWORD_CHARACTERS) {
    throw new Error(`Research direction keywords must contain at most ${MAX_RESEARCH_KEYWORD_CHARACTERS} characters in total`);
  }
  const updatedAt = (input as { updated_at?: unknown }).updated_at;
  return {
    directions,
    updated_at: typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt))
      ? new Date(updatedAt).toISOString() : EMPTY_SET.updated_at,
  };
}

function cleanText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  return cleaned;
}
