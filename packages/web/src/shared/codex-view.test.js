import { describe, expect, test } from "bun:test";
import { renderDetail } from "./codex-view.js";

describe("Codex task actions", () => {
  test("keeps Workplace registration inside the Codex console", () => {
    const html = renderDetail({
      thread: {
        thread_id: "thread-1",
        title: "Unregistered task",
        cwd: "/srv/project",
        mode: "observed",
        phase: "observed",
        app_status: "active",
      },
    });

    expect(html).toContain('type="button" class="primary" data-codex-action="register-workplace"');
    expect(html).not.toContain('href="/#task-hall"');
  });

  test("shows concrete failures and blocks paginated history management", () => {
    const html = renderDetail({
      thread: {
        thread_id: "thread-2",
        title: "Paginated task",
        cwd: "/srv/project",
        workplace_id: "workplace-1",
        mode: "managed",
        phase: "paused",
        app_status: "idle",
        history_mode: "paginated",
        last_error: "Directive delivery failed before turn/start",
      },
      directives: [{
        created_at: "2026-08-30T00:00:00Z",
        actor_id: "operator",
        status: "failed",
        content: "Continue",
        error: "Codex thread preparation failed",
      }],
    });

    expect(html).toContain("Directive delivery failed before turn/start");
    expect(html).toContain("Codex thread preparation failed");
    expect(html).toContain("分页历史");
    expect(html).not.toContain('data-codex-action="resume"');
    expect(html).not.toContain('data-codex-action="instruction"');
    expect(html).toContain('data-codex-action="stop"');
  });
});
