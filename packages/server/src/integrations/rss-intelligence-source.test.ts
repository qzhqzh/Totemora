import { expect, test } from "bun:test";
import { parseRss } from "./rss-intelligence-source";

function feed(body: string, metadata = "<title>AI retrieval update</title><link>https://example.com/release</link>"): string {
  return `<rss><channel><item>${metadata}${body}</item></channel></rss>`;
}

test("RSS descriptions preserve the feed's metadata and exact decoded source URL", () => {
  const [item] = parseRss(feed(
    "<description>The release adds memory retrieval &amp; evaluation for agents.</description>",
    "<title><![CDATA[AI &amp; retrieval &#39;update&#39;]]></title><link><![CDATA[https://example.com/release?x=1&amp;y=%2F#original]]></link><pubDate>Sun, 25 Oct 2026 10:00:00 GMT</pubDate>",
  ), "feeds.bbci.co.uk", "technology");
  expect(item).toEqual({ title: "AI & retrieval 'update'", link: "https://example.com/release?x=1&y=%2F#original",
    source: "feeds.bbci.co.uk", category: "technology", published_at: "Sun, 25 Oct 2026 10:00:00 GMT",
    summary: "The release adds memory retrieval & evaluation for agents." });
});

test("RSS CDATA descriptions become inert text with common entities and controls cleaned", () => {
  const [item] = parseRss(feed(`<description><![CDATA[
    <p>Memory <strong>retrieval</strong>&nbsp;supports &#x41; &amp; &#66;.</p>
    <!-- hidden instruction --><script>throw new Error('must not execute')</script><style>.secret { display: none }</style>
    <p>&ldquo;Bounded&rdquo; &mdash; author&apos;s evidence&#x1F9EA;\u0000\u0007\u007F\u202E.</p>
    <p><a href="https://example.com/comments">Comments</a></p>
  ]]></description>`), "example.com");
  expect(item!.summary).toBe("Memory retrieval supports A & B. “Bounded” — author's evidence🧪.");
  expect(item!.summary).not.toMatch(/hidden|throw|secret|<|Comments|[\u0000-\u001f\u007f\u202e]/u);
});

test("valid descriptions take priority and empty or navigational descriptions fall back to content:encoded", () => {
  expect(parseRss(feed("<description>Original source description.</description><content:encoded>Longer source body.</content:encoded>"), "source")[0]!.summary)
    .toBe("Original source description.");
  for (const description of ["", "&nbsp;", '<![CDATA[<p><a href="https://example.com/comments">Comments</a></p>]]>']) {
    const [item] = parseRss(feed(`<description>${description}</description><content:encoded><![CDATA[<p>Original source body &amp; limitations.</p>]]></content:encoded>`), "source");
    expect(item!.summary).toBe("Original source body & limitations.");
  }
});

test("missing, empty and navigation-only descriptions never become source evidence", () => {
  const descriptions = [
    "", "<description />", "<description><![CDATA[ \n <br/> &nbsp; ]]></description>",
    '<description><![CDATA[<p><a href="https://example.com/comments">Comments</a></p>]]></description>',
    '<description><![CDATA[<p>Article URL: <a href="https://example.com/release">https://example.com/release</a></p><p>Comments URL: <a href="https://example.com/comments">https://example.com/comments</a></p><p>Points: 25</p><p># Comments: 4</p>]]></description>',
    '<description><![CDATA[<p><a href="https://example.com/release">Read more</a> · Share · Comments</p>]]></description>',
    '<description><![CDATA[<ol><li><a href="https://example.com/release">A linked article headline</a>&nbsp;<font color="#666">Publisher Name</font></li></ol>]]></description>',
    "<description>AI retrieval update</description>",
    "<description><![CDATA[<script>hidden text</script><style>hidden text</style><!-- hidden -->]]></description>",
    "<description>&#0;&#xD800;&#x110000;</description>",
  ];
  for (const body of descriptions) expect(parseRss(feed(body), "source")[0]!.summary).toBeUndefined();
});

test("source paragraphs retain meaningful inline links while navigation-only link lists remain empty", () => {
  const [item] = parseRss(feed('<description><![CDATA[<p>The report evaluates <a href="https://example.com/method">memory retrieval</a> with bounded inputs.</p>]]></description>'), "source");
  expect(item!.summary).toBe("The report evaluates memory retrieval with bounded inputs.");
});

test("escaped markup is cleaned and summary text remains bounded without changing link bytes", () => {
  const [escaped] = parseRss(feed("<description>&lt;p&gt;Source &amp;amp; evidence &lt;b&gt;remain readable&lt;/b&gt;.&lt;/p&gt;</description>"), "source");
  expect(escaped!.summary).toBe("Source & evidence remain readable.");
  const [large] = parseRss(feed(`<description><![CDATA[<p>${"源材料与适用条件。".repeat(3000)}</p>]]></description>`), "source");
  expect(large!.summary!.length).toBeLessThanOrEqual(1200);
  expect(large!.summary!.startsWith("源材料与适用条件。")).toBe(true);
  expect(large!.link).toBe("https://example.com/release");
});

test("RSS still considers only the first fifteen item blocks and skips missing titles or links", () => {
  const items = Array.from({ length: 17 }, (_, index) => `<item><title>Item ${index}</title>${index === 0 ? "" : `<link>https://example.com/${index}</link>`}</item>`);
  const parsed = parseRss(`<rss>${items.join("")}</rss>`, "source", "technology");
  expect(parsed).toHaveLength(14);
  expect(parsed[0]!.link).toBe("https://example.com/1");
  expect(parsed.at(-1)!.link).toBe("https://example.com/14");
  expect(parsed.every((item) => item.published_at === undefined && item.summary === undefined)).toBe(true);
});
