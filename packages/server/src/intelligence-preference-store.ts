import { resolve } from "node:path";
import { StateDatabase } from "./state-database";

export interface IntelligencePreferences {
  interests: string[];
  channels: {
    rss: boolean;
    ai_hot: boolean;
    x_trends: boolean;
    weibo_hot: boolean;
  };
  x_woeid: number;
  scan_interval_minutes: number;
  push_interval_seconds: number;
  push_threshold: number;
  novelty_history_hours: number;
  updated_at: string;
}

const DEFAULT_PREFERENCES: IntelligencePreferences = {
  interests: ["人工智能", "开发工具", "开源项目", "网络安全", "重要科技与国际变化"],
  channels: { rss: true, ai_hot: true, x_trends: false, weibo_hot: false },
  x_woeid: 1,
  scan_interval_minutes: 10,
  push_interval_seconds: 60,
  push_threshold: 0.72,
  novelty_history_hours: 72,
  updated_at: new Date(0).toISOString(),
};

export class IntelligencePreferenceStore {
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string) {
    this.state = StateDatabase.open(dataDir);
    this.state.importJsonFile<IntelligencePreferences>(
      resolve(dataDir, "intelligence-preferences.json"),
      (value) => [validate(value)],
      (value) => this.state.putRecord("settings", "intelligence_preferences", value, value.updated_at, value.updated_at),
    );
  }

  async get(): Promise<IntelligencePreferences> {
    return validate(this.state.listRecords<IntelligencePreferences>("settings")
      .find((item) => "scan_interval_minutes" in item) ?? structuredClone(DEFAULT_PREFERENCES));
  }

  async save(input: unknown): Promise<IntelligencePreferences> {
    const value = validate(input);
    value.updated_at = new Date().toISOString();
    this.state.putRecord("settings", "intelligence_preferences", value, value.updated_at, value.updated_at);
    return value;
  }
}

function validate(input: unknown): IntelligencePreferences {
  const value = input as Partial<IntelligencePreferences> | undefined;
  const interests = Array.isArray(value?.interests)
    ? value.interests.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20)
    : DEFAULT_PREFERENCES.interests;
  if (interests.some((item) => item.length > 80)) throw new Error("Each intelligence interest must be at most 80 characters");
  const xWoeid = Number(value?.x_woeid ?? DEFAULT_PREFERENCES.x_woeid);
  if (!Number.isInteger(xWoeid) || xWoeid <= 0) throw new Error("x_woeid must be a positive integer");
  const scanInterval = boundedInteger(value?.scan_interval_minutes, 5, 60, DEFAULT_PREFERENCES.scan_interval_minutes, "scan_interval_minutes");
  const pushInterval = boundedInteger(value?.push_interval_seconds, 60, 3_600, DEFAULT_PREFERENCES.push_interval_seconds, "push_interval_seconds");
  const historyHours = boundedInteger(value?.novelty_history_hours, 6, 720, DEFAULT_PREFERENCES.novelty_history_hours, "novelty_history_hours");
  const pushThreshold = Number(value?.push_threshold ?? DEFAULT_PREFERENCES.push_threshold);
  if (!Number.isFinite(pushThreshold) || pushThreshold < 0.5 || pushThreshold > 0.95) throw new Error("push_threshold must be between 0.5 and 0.95");
  return {
    interests,
    channels: {
      rss: value?.channels?.rss !== false,
      ai_hot: value?.channels?.ai_hot !== false,
      x_trends: value?.channels?.x_trends === true,
      weibo_hot: value?.channels?.weibo_hot === true,
    },
    x_woeid: xWoeid,
    scan_interval_minutes: scanInterval,
    push_interval_seconds: pushInterval,
    push_threshold: pushThreshold,
    novelty_history_hours: historyHours,
    updated_at: typeof value?.updated_at === "string" ? value.updated_at : DEFAULT_PREFERENCES.updated_at,
  };
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, name: string): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}
