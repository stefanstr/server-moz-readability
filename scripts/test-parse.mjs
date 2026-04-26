import assert from "node:assert/strict";
import test from "node:test";
import {
  RedditParser,
  TOOL_NAME,
  WebContentParser,
  WebsiteParser,
  isRedditUrl,
  renderArticleContent,
  renderRedditContent,
  truncateRenderedContent
} from "../dist/index.js";

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
  assert.deepEqual(truncateRenderedContent("abcdef"), {
    content: "abcdef",
    truncated: false
  });

  assert.deepEqual(truncateRenderedContent("abcdef", -1), {
    content: "abcdef",
    truncated: false
  });

  assert.deepEqual(truncateRenderedContent("abcdef", 6), {
    content: "abcdef",
    truncated: false
  });

  assert.deepEqual(truncateRenderedContent("abcdef", 4), {
    content: "abcd",
    truncated: true
  });

  assert.deepEqual(truncateRenderedContent("abcdef", 0), {
    content: "",
    truncated: true
  });

  assert.throws(
    () => truncateRenderedContent("abcdef", -2),
    /maxChars must be an integer greater than or equal to -1/
  );
});

test("WebsiteParser fetchAndParse returns common metadata and supports maxChars", async () => {
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
  assert.equal(defaultResult.metadata.format, "markdown");
  assert.equal(defaultResult.metadata.truncated, false);
  assert.equal(defaultResult.metadata.excerpt, "Story excerpt");
  assert.equal(defaultResult.metadata.byline, "Story author");
  assert.equal(defaultResult.metadata.siteName, "Story site");
  assert.equal(defaultResult.metadata.permalink, "https://example.com/story");
  assert.deepEqual(defaultResult.metadata.provider, { type: "web" });
  assert.match(defaultResult.content, /# Story title/);

  const htmlResult = await parser.fetchAndParse("https://example.com/story", { format: "html" });
  assert.match(htmlResult.content, /<p>Alpha beta gamma delta\.<\/p>/);

  const textResult = await parser.fetchAndParse("https://example.com/story", { format: "text", maxChars: 12 });
  assert.equal(textResult.content, "Story title ");
  assert.equal(textResult.metadata.truncated, true);
});

test("only extract_web_content is advertised as the public tool name", () => {
  assert.equal(TOOL_NAME, "extract_web_content");
  assert.notEqual(TOOL_NAME, "extract_article_content");
});

test("isRedditUrl detects supported Reddit hosts", () => {
  assert.equal(isRedditUrl("https://reddit.com/r/test/comments/abc/title/"), true);
  assert.equal(isRedditUrl("https://www.reddit.com/r/test/comments/abc/title/"), true);
  assert.equal(isRedditUrl("https://old.reddit.com/r/test/comments/abc/title/"), true);
  assert.equal(isRedditUrl("https://redd.it/abc"), true);
  assert.equal(isRedditUrl("https://example.com/r/test/comments/abc/title/"), false);
  assert.equal(isRedditUrl("not a url"), false);
});

test("WebContentParser routes Reddit URLs to RedditParser and other URLs to WebsiteParser", async () => {
  const calls = [];
  const parser = new WebContentParser({
    websiteParser: {
      async fetchAndParse(url) {
        calls.push(["web", url]);
        return { title: "web", content: "web", metadata: { provider: { type: "web" } } };
      }
    },
    redditParser: {
      async fetchAndParse(url) {
        calls.push(["reddit", url]);
        return { title: "reddit", content: "reddit", metadata: { provider: { type: "reddit" } } };
      }
    }
  });

  assert.equal((await parser.fetchAndParse("https://example.com/story")).metadata.provider.type, "web");
  assert.equal((await parser.fetchAndParse("https://www.reddit.com/r/test/comments/abc/title/")).metadata.provider.type, "reddit");
  assert.deepEqual(calls, [
    ["web", "https://example.com/story"],
    ["reddit", "https://www.reddit.com/r/test/comments/abc/title/"]
  ]);
});

test("renderRedditContent supports markdown, html, and text", () => {
  const post = {
    title: "Reddit title",
    body: "Post body",
    outboundUrl: "https://example.com/linked",
    comments: [{
      author: "u/commenter",
      body: "Comment body"
    }]
  };

  const markdown = renderRedditContent(post);
  assert.match(markdown, /# Reddit title/);
  assert.match(markdown, /\[Linked content\]\(https:\/\/example\.com\/linked\)/);
  assert.match(markdown, /## Top comments/);
  assert.match(markdown, /Comment body/);

  const html = renderRedditContent(post, "html");
  assert.match(html, /<article>/);
  assert.match(html, /<h1>Reddit title<\/h1>/);
  assert.match(html, /<section class="reddit-comments">/);

  const text = renderRedditContent(post, "text");
  assert.equal(text, "Reddit title Post body Linked content: https://example.com/linked Top comments u/commenter Comment body");
});

test("RedditParser fetchAndParse returns common metadata and respects maxChars", async () => {
  class StubRedditParser extends RedditParser {
    async fetchRedditPost() {
      return {
        title: "Reddit title",
        body: "Post body alpha beta.",
        outboundUrl: null,
        author: "u/poster",
        subreddit: "test",
        postId: "abc123",
        permalink: "https://www.reddit.com/r/test/comments/abc123/title/",
        commentsTotal: 2,
        comments: [
          { author: "u/one", body: "First comment." },
          { author: "u/two", body: "Second comment." }
        ]
      };
    }
  }

  const parser = new StubRedditParser();
  const result = await parser.fetchAndParse("https://www.reddit.com/r/test/comments/abc123/title/", {
    maxChars: 20
  });

  assert.equal(result.title, "Reddit title");
  assert.equal(result.content, "# Reddit title\n\nPost");
  assert.deepEqual(result.metadata, {
    format: "markdown",
    excerpt: null,
    byline: "u/poster",
    siteName: "Reddit",
    truncated: true,
    permalink: "https://www.reddit.com/r/test/comments/abc123/title/",
    provider: {
      type: "reddit",
      subreddit: "test",
      postId: "abc123",
      commentsIncluded: 2,
      commentsTotal: 2
    }
  });
});
