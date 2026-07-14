import { expect, test } from "bun:test";

import { loadLocalConfig } from "./loader";
import { validateLocalConfig } from "./validation";

test("loads and validates the sample local tribe config", async () => {
  const config = await loadLocalConfig({ configDir: "configs/example" });

  expect(Object.keys(config.providers.providers)).toHaveLength(4);
  expect(config.agents.agents).toHaveLength(5);
  expect(config.tribe.tribe.chief).toBe("deepseek_reasoner");
  expect(() => validateLocalConfig(config)).not.toThrow();
});
