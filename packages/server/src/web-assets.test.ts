import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveWebAsset } from "./web-assets";

const root = "/srv/totemora-web";

describe("resolveWebAsset", () => {
  test("maps application routes and allowlisted modules", () => {
    expect(resolveWebAsset(root, "/")).toBe(resolve(root, "index.html"));
    expect(resolveWebAsset(root, "/skills")).toBe(resolve(root, "index.html"));
    expect(resolveWebAsset(root, "/codex")).toBe(resolve(root, "codex.html"));
    expect(resolveWebAsset(root, "/codex-app.js")).toBe(resolve(root, "codex-app.js"));
    expect(resolveWebAsset(root, "/codex-styles.css")).toBe(resolve(root, "codex-styles.css"));
    expect(resolveWebAsset(root, "/features/codex-supervisor.js")).toBe(resolve(root, "features/codex-supervisor.js"));
    expect(resolveWebAsset(root, "/features/codex-scheduled-subscriptions.js"))
      .toBe(resolve(root, "features/codex-scheduled-subscriptions.js"));
    expect(resolveWebAsset(root, "/features/skills.js")).toBe(resolve(root, "features/skills.js"));
    expect(resolveWebAsset(root, "/shared/dom.js")).toBe(resolve(root, "shared/dom.js"));
  });

  test("rejects traversal, tests, nested paths and unknown assets", () => {
    expect(resolveWebAsset(root, "/features/../app.js")).toBeUndefined();
    expect(resolveWebAsset(root, "/shared/dom.test.js")).toBeUndefined();
    expect(resolveWebAsset(root, "/features/admin/skills.js")).toBeUndefined();
    expect(resolveWebAsset(root, "/package.json")).toBeUndefined();
  });
});
