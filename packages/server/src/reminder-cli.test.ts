import { expect, test } from "bun:test";

import { parseReminderCliArgs } from "./reminder-cli";

test("legacy reminder import is dry-run by default and requires an absolute snapshot", () => {
  expect(parseReminderCliArgs([
    "import-legacy", "--source", "/tmp/memo.db", "--local-date", "2026-08-30",
  ])).toMatchObject({
    command: "import-legacy", source: "/tmp/memo.db", localDate: "2026-08-30", apply: false,
  });
  expect(parseReminderCliArgs([
    "import-legacy", "--source", "/tmp/memo.db", "--apply",
  ])).toMatchObject({ apply: true });
  expect(() => parseReminderCliArgs(["import-legacy", "--source", "memo.db"]))
    .toThrow("absolute snapshot path");
});

test("parses explicit reminder lifecycle commands", () => {
  expect(parseReminderCliArgs([
    "add", "--title", "Release", "--deadline", "2026-09-01", "--importance", "3",
  ])).toMatchObject({ command: "add", title: "Release", deadline: "2026-09-01", importance: 3 });
  expect(parseReminderCliArgs(["complete", "--id", "r-1"]))
    .toMatchObject({ command: "complete", id: "r-1" });
});
