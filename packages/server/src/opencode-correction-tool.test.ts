import { expect, test } from "bun:test";
import { OpenCodeCorrectionTool } from "./opencode-correction-tool";

test("runs OpenCode with a denied-by-default scoped correction policy", async () => {
  const calls: Array<{ command: string[]; env: Record<string, string> }> = [];
  const tool = new OpenCodeCorrectionTool(async (command, options) => {
    calls.push({ command, env: options.env });
    if (command.includes("--version")) return { exit_code: 0, stdout: "1.17.20\n", stderr: "" };
    return { exit_code: 0, stdout: '{"sessionID":"session-1","type":"text"}\n', stderr: "" };
  });
  const result = await tool.correct({
    cwd: "/tmp/demo", goal: "修复测试", files: ["src/demo.ts"],
    validation_commands: ["bun test"], failure: "expected 1, received 2",
  });
  expect(result).toMatchObject({ version: "1.17.20", session_id: "session-1" });
  expect(calls[1]!.command).not.toContain("--auto");
  const config = JSON.parse(calls[1]!.env.OPENCODE_CONFIG_CONTENT!);
  expect(config.permission).toMatchObject({
    "*": "deny", edit: { "*": "deny", "src/demo.ts": "allow" },
    bash: { "*": "deny", "git status*": "allow", "git diff*": "allow", "bun test": "allow" },
    external_directory: "deny",
  });
});
