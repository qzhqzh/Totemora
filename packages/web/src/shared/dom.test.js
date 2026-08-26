import { describe, expect, test } from "bun:test";
import { escapeHtml, externalLink } from "./dom.js";

describe("web DOM safety helpers", () => {
  test("escapes markup before rendering", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("only renders HTTPS values as external links", () => {
    expect(externalLink("https://example.com/a", "Example")).toContain('rel="noopener noreferrer"');
    expect(externalLink("javascript:alert(1)", "Unsafe <label>")).toBe("Unsafe &lt;label&gt;");
  });
});
