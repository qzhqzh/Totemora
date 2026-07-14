export interface OpenCodeCorrectionRequest {
  cwd: string;
  goal: string;
  files: string[];
  validation_commands: string[];
  failure: string;
}

export interface OpenCodeCorrectionResult {
  version: string;
  session_id?: string;
  output: string;
}

type ProcessRunner = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<{ exit_code: number; stdout: string; stderr: string }>;

export class OpenCodeCorrectionTool {
  constructor(private readonly runProcess: ProcessRunner = run) {}

  async correct(request: OpenCodeCorrectionRequest): Promise<OpenCodeCorrectionResult> {
    if (!request.files.length) throw new Error("OpenCode correction requires an approved file scope");
    const versionResult = await this.runProcess(["opencode", "--version"], {
      cwd: request.cwd, env: toolEnvironment({}),
    });
    if (versionResult.exit_code !== 0) throw new Error("OpenCode is unavailable");
    const permission = {
      "*": "deny",
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      glob: "allow",
      grep: "allow",
      edit: Object.fromEntries(["*", ...request.files].map((path) => [path, path === "*" ? "deny" : "allow"])),
      bash: Object.fromEntries([
        ["*", "deny"],
        ["git status*", "allow"],
        ["git diff*", "allow"],
        ...request.validation_commands.map((command) => [command, "allow"]),
      ]),
      external_directory: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
      question: "deny",
    };
    const prompt = [
      "你是 Totemora 调用的受限代码修复工具，不负责 Git Flow。",
      `目标：${request.goal}`,
      `只允许修改这些文件：${JSON.stringify(request.files)}`,
      `失败证据：${request.failure}`,
      `允许的验证命令：${JSON.stringify(request.validation_commands)}`,
      "修复导致验证失败的最小问题；不要提交、push、创建 Issue/PR、切换分支或修改范围外文件。",
    ].join("\n");
    const result = await this.runProcess([
      "opencode", "run", "--pure", "--format", "json", "--dir", request.cwd,
      "--title", "Totemora policy-gated correction", prompt,
    ], {
      cwd: request.cwd,
      env: toolEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) }),
    });
    if (result.exit_code !== 0) throw new Error(`OpenCode correction failed: ${result.stderr.trim() || result.stdout.trim()}`);
    const sessionId = [...result.stdout.matchAll(/"sessionID"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
    return {
      version: versionResult.stdout.trim(),
      session_id: sessionId,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000),
    };
  }
}

async function run(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => process.kill(), 10 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { exit_code: exitCode, stdout, stderr };
}

function toolEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    ...extra,
  };
}
