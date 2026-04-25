import assert from "node:assert/strict";
import test from "node:test";
import { WebsiteParser, renderArticleContent, truncateRenderedContent } from "../dist/index.js";

const sampleArticle = {
  title: "Sample title",
  content: `
    <article>
      <h1>Hello world</h1>
      <p>This is a <strong>test</strong>.</p>
      <pre><code>const value = 1;</code></pre>
    </article>
  `,
  excerpt: "Sample excerpt",
  byline: "Sample author",
  siteName: "Sample site"
};

test("renderArticleContent returns markdown by default", () => {
  const rendered = renderArticleContent(sampleArticle);
  assert.match(rendered, /# Hello world/);
  assert.match(rendered, /\*\*test\*\*/);
  assert.match(rendered, /```/);
});

test("renderArticleContent returns cleaned html when requested", () => {
  const rendered = renderArticleContent(sampleArticle, "html");
  assert.match(rendered, /<article>/);
  assert.match(rendered, /<strong>test<\/strong>/);
});

test("renderArticleContent returns text derived from article html", () => {
  const rendered = renderArticleContent(sampleArticle, "text");
  assert.equal(rendered, "Hello world This is a test. const value = 1;");
});

test("truncateRenderedContent clips after rendering and reports truncation", () => {
  assert.deepEqual(truncateRenderedContent("abcdef", 6), {
    content: "abcdef",
    truncated: false
  });

  assert.deepEqual(truncateRenderedContent("abcdef", 4), {
    content: "abcd",
    truncated: true
  });
});

test("WebsiteParser fetchAndParse preserves markdown default and supports maxChars", async () => {
  class StubParser extends WebsiteParser {
    async fetchArticle() {
      return {
        title: "Story title",
        content: `
          <article>
            <h1>Story title</h1>
            <p>Alpha beta gamma delta.</p>
          </article>
        `,
        excerpt: "Story excerpt",
        byline: "Story author",
        siteName: "Story site"
      };
    }
  }

  const parser = new StubParser();

  const defaultResult = await parser.fetchAndParse("https://example.com/story");
  assert.equal(defaultResult.format, "markdown");
  assert.equal(defaultResult.truncated, false);
  assert.match(defaultResult.content, /# Story title/);

  const htmlResult = await parser.fetchAndParse("https://example.com/story", { format: "html" });
  assert.match(htmlResult.content, /<p>Alpha beta gamma delta\.<\/p>/);

  const textResult = await parser.fetchAndParse("https://example.com/story", { format: "text", maxChars: 12 });
  assert.equal(textResult.content, "Story title ");
  assert.equal(textResult.truncated, true);
});
