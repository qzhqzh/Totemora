import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseDealsCliArgs } from "./deals-cli";

test("deals CLI keeps imports dry-run by default and requires an absolute snapshot", () => {
  expect(parseDealsCliArgs([
    "import-legacy", "--source", "/tmp/deals.db", "--source-ref", "notice-ntfy:deals:test",
  ])).toMatchObject({ command: "import-legacy", source: "/tmp/deals.db", apply: false });
  expect(parseDealsCliArgs([
    "import-legacy", "--source", "/tmp/deals.db", "--apply",
  ])).toMatchObject({ apply: true });
  expect(() => parseDealsCliArgs(["import-legacy", "--source", "relative.db"])).toThrow("absolute");
  expect(parseDealsCliArgs(["list", "--status", "delivered", "--limit", "20", "--data-dir", resolve("data")]))
    .toMatchObject({ command: "list", status: "delivered", limit: 20 });
});
