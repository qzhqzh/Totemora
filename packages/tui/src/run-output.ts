import type { TaskReport } from "@totemora/core";

export interface TextWriter {
  write(chunk: string): boolean | void;
}

export function writeTaskReport(
  report: TaskReport | undefined,
  runId: string,
  outcome: string | undefined,
  usage: { calls: number; total_tokens: number } | undefined,
  stdout: TextWriter,
): void {
  if (!report) throw new Error("Completed run has no task report");
  stdout.write(`\n# ${report.title}\n\n${report.summary}\n\n`);
  stdout.write("## Findings\n");
  for (const finding of report.findings) {
    stdout.write(`- ${finding.claim}\n`);
    for (const evidence of finding.evidence) stdout.write(`  - Evidence: ${evidence}\n`);
  }
  stdout.write("\n## Recommendations\n");
  if (report.recommendations.length === 0) stdout.write("- None\n");
  for (const recommendation of report.recommendations) {
    stdout.write(`- [${recommendation.priority}] ${recommendation.action}: ${recommendation.reason}\n`);
  }
  stdout.write("\n## Acceptance\n");
  for (const item of report.acceptance_review) {
    stdout.write(`- [${item.status}] ${item.criterion}: ${item.evidence}\n`);
  }
  stdout.write(`\nRun: ${runId}\n`);
  stdout.write(`Outcome: ${outcome ?? "unknown"}\n`);
  writeUsage(usage, stdout);
}

export function writeUsage(
  usage: { calls: number; total_tokens: number } | undefined,
  stdout: TextWriter,
): void {
  if (usage) stdout.write(`Usage: ${usage.total_tokens} tokens across ${usage.calls} calls\n`);
}
