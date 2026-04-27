import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PublicError,
  RedditParser,
  TOOL_NAME,
  WebContentParser,
  WebsiteParser,
  fetchWithPolicy,
  isDirectCliRun,
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

const DEFAULT_OUTPUT_CHAR_LIMIT = 50_000;

function loadFixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function loadJsonFixture(name) {
  return JSON.parse(loadFixture(name));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withUrlPolicyEnv(env, callback) {
  const keys = ["ALLOW_PRIVATE_HOSTS", "ALLOWED_HOSTS", "BLOCKED_HOSTS"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  try {
    for (const key of keys) {
      delete process.env[key];
    }

    for (const [key, value] of Object.entries(env)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    return callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);

      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("WebsiteParser extracts representative HTML fixtures across formats and truncation", async () => {
  const cases = [
    {
      name: "clean-article.html",
      url: "https://example.com/deep-work",
      title: "Deep Work in Small Windows",
      expectedMarkdown: [
        "Most calendars are not built for concentration",
        "The key is to name the one decision"
      ],
      absentMarkdown: ["Markets", "Copyright 2026"]
    },
    {
      name: "boilerplate-heavy-intro.html",
      url: "https://example.com/cities/maps",
      title: "Sustainable Maps for Busy Cities",
      expectedMarkdown: [
        "City planners are updating street maps",
        "quiet source of public frustration"
      ],
      absentMarkdown: ["Accept cookies", "Sponsored: smarter luggage", "Subscribe to our newsletter"]
    },
    {
      name: "list-heavy-page.html",
      url: "https://example.com/open-data/checklist",
      title: "Checklist for Launching a Public Dataset",
      expectedMarkdown: [
        "## Before publication",
        "*   Confirm every column has a plain-language definition.",
        "1.  Record the first external question."
      ],
      absentMarkdown: []
    }
  ];

  for (const fixtureCase of cases) {
    const parser = new WebsiteParser({
      httpClient: async () => ({
        data: loadFixture(fixtureCase.name),
        finalUrl: fixtureCase.url,
        headers: { "content-type": "text/html" }
      })
    });

    const markdownResult = await parser.fetchAndParse(fixtureCase.url);
    assert.equal(markdownResult.title, fixtureCase.title);
    assert.equal(markdownResult.metadata.format, "markdown");
    assert.equal(markdownResult.metadata.permalink, fixtureCase.url);
    assert.deepEqual(markdownResult.metadata.provider, { type: "web" });

    for (const expected of fixtureCase.expectedMarkdown) {
      assert.match(markdownResult.content, new RegExp(escapeRegExp(expected)));
    }

    for (const absent of fixtureCase.absentMarkdown) {
      assert.doesNotMatch(markdownResult.content, new RegExp(escapeRegExp(absent)));
    }

    const htmlResult = await parser.fetchAndParse(fixtureCase.url, { format: "html" });
    assert.match(htmlResult.content, /<article>|<p>/);
    assert.equal(htmlResult.metadata.format, "html");

    const textResult = await parser.fetchAndParse(fixtureCase.url, { format: "text", maxChars: 80 });
    assert.equal(textResult.content.length, 80);
    assert.equal(textResult.metadata.format, "text");
    assert.equal(textResult.metadata.truncated, true);
  }
});

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

test("truncateRenderedContent applies the default output cap and supports unlimited override", () => {
  const longContent = "x".repeat(DEFAULT_OUTPUT_CHAR_LIMIT + 1);
  const defaultResult = truncateRenderedContent(longContent);

  assert.equal(defaultResult.content.length, DEFAULT_OUTPUT_CHAR_LIMIT);
  assert.equal(defaultResult.truncated, true);

  assert.deepEqual(truncateRenderedContent(longContent, -1), {
    content: longContent,
    truncated: false
  });
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

test("WebsiteParser applies the default output cap and lets maxChars disable it", async () => {
  class LongArticleParser extends WebsiteParser {
    async fetchArticle() {
      return {
        title: "Long story",
        content: `<article><p>${"w".repeat(DEFAULT_OUTPUT_CHAR_LIMIT + 25)}</p></article>`,
        excerpt: null,
        byline: null,
        siteName: null
      };
    }
  }

  const parser = new LongArticleParser();

  const defaultResult = await parser.fetchAndParse("https://example.com/long-story", {
    format: "text"
  });
  assert.equal(defaultResult.content.length, DEFAULT_OUTPUT_CHAR_LIMIT);
  assert.equal(defaultResult.metadata.truncated, true);

  const unlimitedResult = await parser.fetchAndParse("https://example.com/long-story", {
    format: "text",
    maxChars: -1
  });
  assert.equal(unlimitedResult.content.length, DEFAULT_OUTPUT_CHAR_LIMIT + 25);
  assert.equal(unlimitedResult.metadata.truncated, false);
});

test("WebsiteParser fetchArticle runs validate, fetch, and extract stages", async () => {
  const calls = [];

  class StagedParser extends WebsiteParser {
    validateUrl(url) {
      calls.push(["validate", url]);
      return "https://example.com/normalized";
    }

    async fetchHtml(url) {
      calls.push(["fetch", url]);
      return "<html><body><article>Story body</article></body></html>";
    }

    extractArticle(html, url) {
      calls.push(["extract", html, url]);
      return {
        title: "Story title",
        content: "<article>Story body</article>",
        excerpt: null,
        byline: null,
        siteName: null
      };
    }
  }

  const parser = new StagedParser();
  const article = await parser.fetchArticle("https://example.com/story");

  assert.equal(article.title, "Story title");
  assert.deepEqual(calls, [
    ["validate", "https://example.com/story"],
    ["fetch", "https://example.com/normalized"],
    ["extract", "<html><body><article>Story body</article></body></html>", "https://example.com/normalized"]
  ]);
});

test("WebsiteParser validateUrl enforces default URL hygiene", () => {
  withUrlPolicyEnv({}, () => {
    const parser = new WebsiteParser();

    assert.equal(parser.validateUrl("https://example.com/story"), "https://example.com/story");
    assert.throws(
      () => parser.validateUrl("file:///etc/passwd"),
      /URL must use http or https/
    );
    assert.throws(
      () => parser.validateUrl("http://localhost:3000/admin"),
      /Private or local hosts are blocked by policy: localhost/
    );
    assert.throws(
      () => parser.validateUrl("http://127.0.0.1:3000/admin"),
      /Private or local hosts are blocked by policy: 127\.0\.0\.1/
    );
    assert.throws(
      () => parser.validateUrl("http://10.0.0.5/private"),
      /Private or local hosts are blocked by policy: 10\.0\.0\.5/
    );
    assert.throws(
      () => parser.validateUrl("http://172.16.0.5/private"),
      /Private or local hosts are blocked by policy: 172\.16\.0\.5/
    );
    assert.throws(
      () => parser.validateUrl("http://192.168.1.5/private"),
      /Private or local hosts are blocked by policy: 192\.168\.1\.5/
    );
    assert.throws(
      () => parser.validateUrl("http://169.254.1.5/private"),
      /Private or local hosts are blocked by policy: 169\.254\.1\.5/
    );
    assert.throws(
      () => parser.validateUrl("http://[::1]/private"),
      /Private or local hosts are blocked by policy: ::1/
    );
  });
});

test("WebsiteParser rejects blocked and local URL fixtures", () => {
  withUrlPolicyEnv({}, () => {
    const parser = new WebsiteParser();
    const blockedUrls = loadJsonFixture("blocked-local-urls.json");

    for (const fixtureCase of blockedUrls) {
      assert.throws(
        () => parser.validateUrl(fixtureCase.url),
        new RegExp(escapeRegExp(fixtureCase.message))
      );
    }
  });
});

test("WebsiteParser validateUrl supports private-host escape hatch", () => {
  withUrlPolicyEnv({ ALLOW_PRIVATE_HOSTS: "true" }, () => {
    const parser = new WebsiteParser();

    assert.equal(parser.validateUrl("http://localhost:3000/admin"), "http://localhost:3000/admin");
    assert.equal(parser.validateUrl("http://192.168.1.5/private"), "http://192.168.1.5/private");
  });
});

test("WebsiteParser validateUrl supports allowed and blocked host policies", () => {
  withUrlPolicyEnv({ ALLOWED_HOSTS: "example.com,docs.example.com" }, () => {
    const parser = new WebsiteParser();

    assert.equal(parser.validateUrl("https://docs.example.com/story"), "https://docs.example.com/story");
    assert.throws(
      () => parser.validateUrl("https://other.example.com/story"),
      /Host is not allowed by policy: other\.example\.com/
    );
  });

  withUrlPolicyEnv({ BLOCKED_HOSTS: "example.com" }, () => {
    const parser = new WebsiteParser();

    assert.throws(
      () => parser.validateUrl("https://example.com/story"),
      /Host is blocked by policy: example\.com/
    );
    assert.equal(parser.validateUrl("https://docs.example.com/story"), "https://docs.example.com/story");
  });
});

test("fetchWithPolicy applies request limits and disables axios redirects", async () => {
  let seenRequest = null;
  const response = await fetchWithPolicy("https://example.com/story", {
    allowedContentTypes: new Set(["text/html"]),
    requester: async (url, config) => {
      seenRequest = { url, config };
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        data: "<html><body><article>Story</article></body></html>"
      };
    }
  });

  assert.equal(response.data, "<html><body><article>Story</article></body></html>");
  assert.equal(seenRequest.url, "https://example.com/story");
  assert.equal(seenRequest.config.timeout, 10000);
  assert.equal(seenRequest.config.maxContentLength, 5 * 1024 * 1024);
  assert.equal(seenRequest.config.maxBodyLength, 5 * 1024 * 1024);
  assert.equal(seenRequest.config.maxRedirects, 0);
  assert.equal(seenRequest.config.responseType, "text");
  assert.match(seenRequest.config.headers["User-Agent"], /^make-content-parsable\/2\.0\.0 /);
  assert.ok(seenRequest.config.httpAgent);
  assert.ok(seenRequest.config.httpsAgent);
});

test("fetchWithPolicy reports oversized responses as public errors", async () => {
  const axiosError = Object.assign(new Error("maxContentLength size of 5242880 exceeded"), {
    name: "AxiosError",
    code: "ERR_BAD_RESPONSE"
  });

  await assert.rejects(
    () => fetchWithPolicy("https://example.com/too-large", {
      allowedContentTypes: new Set(["text/html"]),
      requester: async () => {
        throw axiosError;
      }
    }),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Response exceeded maximum fetch size of 5 MiB");
      return true;
    }
  );
});

test("fetchWithPolicy normalizes timeout failures", async () => {
  const axiosError = Object.assign(new Error("timeout of 10000ms exceeded"), {
    name: "AxiosError",
    code: "ECONNABORTED"
  });

  await assert.rejects(
    () => fetchWithPolicy("https://example.com/slow", {
      requester: async () => {
        throw axiosError;
      }
    }),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Request timed out");
      return true;
    }
  );
});

test("fetchWithPolicy normalizes low-level fetch failures", async () => {
  const axiosError = Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), {
    name: "AxiosError",
    code: "ENOTFOUND"
  });

  await assert.rejects(
    () => fetchWithPolicy("https://example.invalid/story", {
      requester: async () => {
        throw axiosError;
      }
    }),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Failed to fetch web content");
      assert.doesNotMatch(error.message, /ENOTFOUND|example\.invalid/);
      return true;
    }
  );
});

test("fetchWithPolicy blocks redirects to private hosts", async () => {
  const requestedUrls = [];

  await assert.rejects(
    () => fetchWithPolicy("https://example.com/start", {
      allowedContentTypes: new Set(["text/html"]),
      requester: async (url) => {
        requestedUrls.push(url);
        return {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
          data: ""
        };
      }
    }),
    /Private or local hosts are blocked by policy: 127\.0\.0\.1/
  );

  assert.deepEqual(requestedUrls, ["https://example.com/start"]);
});

test("fetchWithPolicy reports redirect loops with a stable message", async () => {
  const requestedUrls = [];

  await assert.rejects(
    () => fetchWithPolicy("https://example.com/start", {
      maxRedirects: 1,
      requester: async (url) => {
        requestedUrls.push(url);
        return {
          status: 302,
          headers: { location: "/next" },
          data: ""
        };
      }
    }),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Too many redirects");
      return true;
    }
  );

  assert.deepEqual(requestedUrls, [
    "https://example.com/start",
    "https://example.com/next"
  ]);
});

test("fetchWithPolicy follows fixture redirect chain and returns the final HTML response", async () => {
  const responses = loadJsonFixture("redirect-chain.json");
  const requestedUrls = [];

  const response = await fetchWithPolicy("https://example.com/start", {
    allowedContentTypes: new Set(["text/html"]),
    requester: async (url) => {
      requestedUrls.push(url);
      const fixtureResponse = responses.find(item => item.url === url);
      assert.ok(fixtureResponse, `Missing redirect fixture response for ${url}`);

      return {
        status: fixtureResponse.status,
        headers: fixtureResponse.headers,
        data: fixtureResponse.dataFixture
          ? loadFixture(fixtureResponse.dataFixture)
          : fixtureResponse.data
      };
    }
  });

  assert.deepEqual(requestedUrls, [
    "https://example.com/start",
    "https://example.com/articles/final"
  ]);
  assert.equal(response.finalUrl, "https://example.com/articles/final");
  assert.match(response.data, /Deep Work in Small Windows/);
});

test("fetchWithPolicy rejects unsupported content types before parsing", async () => {
  const fixtureResponse = loadJsonFixture("non-html-response.json");

  await assert.rejects(
    () => fetchWithPolicy("https://example.com/file.pdf", {
      allowedContentTypes: new Set(["text/html"]),
      requester: async () => fixtureResponse
    }),
    /Unsupported response content type/
  );
});

test("WebsiteParser reports invalid and non-HTML URLs with stable messages", async () => {
  const parser = new WebsiteParser({
    httpClient: (url, options) => fetchWithPolicy(url, {
      ...options,
      requester: async () => loadJsonFixture("non-html-response.json")
    })
  });

  await assert.rejects(
    () => parser.fetchArticle("not a url"),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Invalid URL");
      return true;
    }
  );

  await assert.rejects(
    () => parser.fetchArticle("https://example.com/file.pdf"),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Non-HTML response");
      return true;
    }
  );
});

test("WebsiteParser reports parser failures separately from fetch failures", async () => {
  class ThrowingParser extends WebsiteParser {
    async fetchHtml() {
      return "<html><body><article>Story body</article></body></html>";
    }

    extractArticle() {
      throw new Error("readability crashed");
    }
  }

  await assert.rejects(
    () => new ThrowingParser().fetchArticle("https://example.com/story"),
    error => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "Failed to parse web content");
      assert.doesNotMatch(error.message, /readability crashed/);
      return true;
    }
  );
});

test("WebsiteParser fetchArticle hides low-level network details", async () => {
  class LeakyParser extends WebsiteParser {
    async fetchHtml() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
    }
  }

  await assert.rejects(
    () => new LeakyParser().fetchArticle("https://example.com/story"),
    error => {
      assert.equal(error.message, "Failed to fetch web content");
      assert.doesNotMatch(error.message, /127\.0\.0\.1|6379|ECONNREFUSED/);
      return true;
    }
  );
});

test("only extract_web_content is advertised as the public tool name", () => {
  assert.equal(TOOL_NAME, "extract_web_content");
  assert.notEqual(TOOL_NAME, "extract_article_content");
});

test("CLI entrypoint detection works through npm bin symlinks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "make-content-parsable-"));
  const linkPath = join(tempDir, "make-content-parsable");

  try {
    symlinkSync(new URL("../dist/index.js", import.meta.url), linkPath);
    assert.equal(isDirectCliRun(new URL("../dist/index.js", import.meta.url).href, linkPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test("RedditParser applies the default output cap and lets maxChars disable it", async () => {
  class LongRedditParser extends RedditParser {
    async fetchRedditPost() {
      return {
        title: "Long Reddit title",
        body: "r".repeat(DEFAULT_OUTPUT_CHAR_LIMIT + 25),
        outboundUrl: null,
        author: "u/poster",
        subreddit: "test",
        postId: "abc123",
        permalink: "https://www.reddit.com/r/test/comments/abc123/title/",
        commentsTotal: 0,
        comments: []
      };
    }
  }

  const parser = new LongRedditParser();

  const defaultResult = await parser.fetchAndParse("https://www.reddit.com/r/test/comments/abc123/title/");
  assert.equal(defaultResult.content.length, DEFAULT_OUTPUT_CHAR_LIMIT);
  assert.equal(defaultResult.metadata.truncated, true);

  const unlimitedResult = await parser.fetchAndParse("https://www.reddit.com/r/test/comments/abc123/title/", {
    maxChars: -1
  });
  assert.ok(unlimitedResult.content.length > DEFAULT_OUTPUT_CHAR_LIMIT);
  assert.equal(unlimitedResult.metadata.truncated, false);
});

test("RedditParser rejects invalid redd.it post ids before fetching", async () => {
  const parser = new RedditParser({
    httpClient: async () => {
      throw new Error("fetch should not run");
    }
  });

  await assert.rejects(
    () => parser.fetchRedditPost("https://redd.it/abc-123"),
    /Reddit short URL has an invalid post id/
  );
});

test("RedditParser accepts valid Reddit JSON through the shared HTTP policy", async () => {
  const parser = new RedditParser({
    httpClient: async (url, options) => {
      assert.equal(url, "https://www.reddit.com/comments/abc123.json?raw_json=1&sort=top&limit=20");
      assert.equal(options.responseType, "json");

      return {
        data: [
          {
            data: {
              children: [{
                data: {
                  title: "Reddit title",
                  selftext: "Post body",
                  is_self: true,
                  author: "poster",
                  subreddit: "test",
                  id: "abc123",
                  permalink: "/r/test/comments/abc123/title/",
                  num_comments: 0
                }
              }]
            }
          },
          { data: { children: [] } }
        ]
      };
    }
  });

  const post = await parser.fetchRedditPost("https://redd.it/abc123");

  assert.equal(post.title, "Reddit title");
  assert.equal(post.body, "Post body");
  assert.equal(post.postId, "abc123");
});
