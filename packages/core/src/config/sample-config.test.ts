import { expect, test } from "bun:test";

import { loadLocalConfig } from "./loader";
import { validateLocalConfig } from "./validation";

test("loads and validates the sample local tribe config", async () => {
  const config = await loadLocalConfig({ configDir: "configs/example" });

  expect(Object.keys(config.providers.providers)).toHaveLength(5);
  expect(config.agents.agents).toHaveLength(7);
  expect(config.agents.agents.find((member) => member.id === "qwen_intelligence")?.lineage?.mentor_id).toBe("deepseek_reasoner");
  expect(config.tribe.tribe.chief).toBe("deepseek_reasoner");
  expect(() => validateLocalConfig(config)).not.toThrow();
});
