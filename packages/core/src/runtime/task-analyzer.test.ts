import { expect, test } from "bun:test";
import { analyzeTaskIntent } from "./task-analyzer";

test("classifies inspect, change, operate and continuing missions", () => {
  expect(analyzeTaskIntent({ goal: "分析这个项目", has_workspace: true }).type).toBe("inspect");
  expect(analyzeTaskIntent({ goal: "修复这个错误", has_workspace: true })).toMatchObject({ type: "change", execution_enabled: false });
  expect(analyzeTaskIntent({ goal: "运行测试并部署", has_workspace: true })).toMatchObject({ type: "operate", execution_enabled: false });
  expect(analyzeTaskIntent({ goal: "继续处理", has_workspace: true, continuing: true })).toMatchObject({ type: "continue", execution_enabled: true });
  expect(analyzeTaskIntent({ goal: "继续修复代码", has_workspace: true, continuing: true })).toMatchObject({ type: "change", execution_enabled: false });
  expect(analyzeTaskIntent({ goal: "按这个项目的规范检查并提交当前改动", has_workspace: true })).toMatchObject({ type: "change", execution_enabled: false });
});

test("keeps answer requests gated until a conversation runtime exists", () => {
  expect(analyzeTaskIntent({ goal: "给我一些架构建议", has_workspace: false })).toMatchObject({ type: "answer", execution_enabled: false });
});
