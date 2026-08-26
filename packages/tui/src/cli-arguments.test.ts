import { expect, test } from "bun:test";

import { parseCliArguments } from "./cli-arguments";

test("CLI arguments separate commands, Gateway selectors and offline mode", () => {
  expect(parseCliArguments([
    "run", "inspect", "--workplace", "work-1", "--mission", "mission-1",
    "--accept", "cite files", "--max-members", "2", "--offline",
  ])).toMatchObject({
    command: ["run", "inspect"], workplace: "work-1", mission: "mission-1",
    acceptance: ["cite files"], maxMembers: 2, offline: true,
  });
});

test("CLI arguments reject missing option values and unsafe budgets", () => {
  expect(() => parseCliArguments(["run", "inspect", "--workspace"]))
    .toThrow("Missing value for --workspace");
  expect(() => parseCliArguments(["run", "inspect", "--max-total-tokens", "999999999999999999999"]))
    .toThrow("--max-total-tokens must be a positive integer");
});
