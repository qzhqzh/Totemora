---
name: firecrawl
description: "Use or integrate Firecrawl when named, or when the task requires its research index, scraping or monitoring capability."
---

# Firecrawl

Use the project MCP server named `firecrawl` for Firecrawl work performed during a Codex session. Keep MCP use separate from product integration: MCP gives Codex tools, while product code calls the Firecrawl API or SDK at runtime.

## Route the request

- Search scientific or engineering literature with the research-index paper tools. Inspect a paper and retrieve relevant passages before making evidence claims; expand through related papers, citations, or references only when useful.
- Search GitHub history with the research-index GitHub tools when the request concerns issues, pull requests, discussions, or README content.
- Start with search when discovering pages. Use scrape for a known public URL, interact only when clicks or navigation are necessary, and parse for a local or non-public document.
- Use monitoring when the same source needs recurring change detection or notifications. Monitoring and other account-scoped operations may require authenticated Firecrawl access.
- For a Totemora product feature, add a bounded client under the Server integration layer and inject `FIRECRAWL_API_KEY` through runtime secrets. Do not call Firecrawl directly from Web, MCP adapters, or HTTP route handlers.

## Authentication and secrets

- The project MCP uses OAuth. If authentication is requested, run `codex mcp login firecrawl` and let the human complete browser authorization.
- Never place API keys in this skill, tracked configuration, prompts, logs, tests, or source code. Add only a placeholder to `.env.example` when product integration needs one.
- Treat any credential pasted into chat or another recorded channel as exposed. Do not save or reuse it; ask the owner to revoke it and provide a rotated credential through the runtime secret mechanism.

## Research evidence

1. Form a precise query that includes the crop or organism, biological problem, method or intervention, and useful date constraints.
2. Search broadly, then inspect the most relevant records and full-text passages.
3. Deduplicate by DOI or stable paper identifier, falling back to normalized title and year.
4. Preserve title, authors, publication date, journal or source, DOI or stable URL, and the passages supporting each conclusion.
5. Distinguish source-backed findings from synthesis or inference. Do not treat a search snippet as sufficient evidence for a strong claim.
6. When feeding Totemora's research-radar pipeline, normalize results through the Server integration boundary and preserve the existing review and publication gates.

## References

- Firecrawl API documentation: https://docs.firecrawl.dev
- Firecrawl integration skills: https://github.com/firecrawl/skills
- Firecrawl CLI: https://github.com/firecrawl/cli
- Firecrawl workflow skills: https://github.com/firecrawl/firecrawl-workflows
