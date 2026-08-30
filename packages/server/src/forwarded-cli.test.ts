import { expect, test } from "bun:test";

import { parseForwardedCliArgs } from "./forwarded-cli";

test("forwarded CLI defaults legacy import to dry-run and bounds list input", () => {
  expect(parseForwardedCliArgs(["import-legacy", "--source", "/tmp/history.db"]))
    .toMatchObject({ command: "import-legacy", apply: false });
  expect(parseForwardedCliArgs(["import-legacy", "--source", "/tmp/history.db", "--apply"]))
    .toMatchObject({ apply: true });
  expect(() => parseForwardedCliArgs(["import-legacy", "--source", "history.db"])).toThrow("absolute");
  expect(parseForwardedCliArgs(["list", "--status", "uncertain", "--limit", "20"]))
    .toMatchObject({ command: "list", status: "uncertain", limit: 20 });
});
