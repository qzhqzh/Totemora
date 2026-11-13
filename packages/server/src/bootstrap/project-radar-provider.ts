import { JevDecisionProvider } from "@totemora/providers";

export function loadProjectRadarProvider(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  const model = env.TOTEMORA_JEV_MODEL?.trim() || "jev-latest";
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error("Invalid TOTEMORA_JEV_MODEL");
  return { provider: apiKey ? new JevDecisionProvider({ apiKey, model, timeoutMs: 10_000 }) : undefined, model };
}
