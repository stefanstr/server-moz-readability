# Make Content Parsable

> Caveat: this MCP server was vibecoded. Treat it with appropriate caution, review the code before using it in sensitive environments, and expect that some edge cases may need hardening.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that turns web URLs into clean, LLM-friendly content. It extracts readable Markdown, HTML, or plain text from normal web pages with Mozilla Readability, and it handles public Reddit URLs through Reddit JSON by returning the post plus top comments.

This fork builds on the original work by [Max Zimmer](https://emzimmer.com/) in [emzimmer/server-moz-readability](https://github.com/emzimmer/server-moz-readability). The impulse to iterate on it was the need for proper Reddit handling, so Reddit URLs can be fetched through Reddit JSON rather than treated like ordinary pages.

This fork is distributed from GitHub and is not currently published to the npm registry.

## Features

- Removes ads, navigation, footers, and other page chrome from regular web pages
- Returns content as Markdown, HTML, or plain text
- Extracts public Reddit posts and up to 20 top-level comments sorted by top without OAuth
- Returns stable metadata including format, permalink, provider type, excerpt, byline, site name, and truncation status
- Caps fetched responses and rendered output by default so large pages stay predictable
- Blocks private and local hosts by default, with environment variables for stricter or local-only policies
- Handles invalid URLs, unsupported content types, redirects, timeouts, and oversized responses with clear errors

## Installation

Run directly from GitHub:

```bash
npx -y --package github:stefanstr/make-content-parsable -- make-content-parsable
```

Install into a project from GitHub:

```bash
npm install github:stefanstr/make-content-parsable
```

Run an installed copy:

```bash
npx make-content-parsable
```

Requirements:

- Node.js 18 or newer
- An MCP client that can run stdio servers

## MCP Configuration

### Codex

Add the server with the Codex CLI:

```bash
codex mcp add make-content-parsable -- npx -y --package github:stefanstr/make-content-parsable -- make-content-parsable
```

Or add it manually to `~/.codex/config.toml`:

```toml
[mcp_servers.make-content-parsable]
command = "npx"
args = ["-y", "--package", "github:stefanstr/make-content-parsable", "--", "make-content-parsable"]
```

With local policy controls:

```toml
[mcp_servers.make-content-parsable]
command = "npx"
args = ["-y", "--package", "github:stefanstr/make-content-parsable", "--", "make-content-parsable"]

[mcp_servers.make-content-parsable.env]
ALLOWED_HOSTS = "example.com,docs.example.com"
BLOCKED_HOSTS = "tracking.example.com"
```

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "make-content-parsable": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "github:stefanstr/make-content-parsable",
        "--",
        "make-content-parsable"
      ]
    }
  }
}
```

With local policy controls:

```json
{
  "mcpServers": {
    "make-content-parsable": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "github:stefanstr/make-content-parsable",
        "--",
        "make-content-parsable"
      ],
      "env": {
        "ALLOWED_HOSTS": "example.com,docs.example.com",
        "BLOCKED_HOSTS": "tracking.example.com"
      }
    }
  }
}
```

The server exposes one tool: `extract_web_content`.

## Tool Reference

Use `extract_web_content` when the model needs to read, summarize, quote, analyze, or extract readable content from a URL. Normal web pages are extracted with Mozilla Readability. Public Reddit URLs are fetched through Reddit JSON and return the post plus top comments.

### Arguments

```json
{
  "url": "https://example.com/article",
  "format": "markdown",
  "maxChars": 50000,
  "excerptMode": "start"
}
```

| Argument | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | yes | none | Full `http` or `https` URL to extract. |
| `format` | string | no | `markdown` | Output format. Supported values: `markdown`, `html`, `text`. |
| `maxChars` | integer | no | `50000` | Maximum characters returned after rendering. Use `-1` for no output cap. |
| `excerptMode` | string | no | `start` | Truncation strategy for web article output. Supported values: `start`, `best`. |

`excerptMode: "start"` returns the beginning of rendered content when `maxChars` truncates output. `excerptMode: "best"` applies to Markdown and text web article output and tries to choose a high-signal content window when Readability leaves boilerplate near the start. HTML output and Reddit currently use start-style truncation even when `best` is passed.

### Response Shape

The MCP tool returns JSON as text:

```json
{
  "title": "Article title",
  "content": "Rendered article content...",
  "metadata": {
    "format": "markdown",
    "excerpt": "Brief summary or null",
    "byline": "Author information or null",
    "siteName": "Source website name or null",
    "truncated": false,
    "permalink": "https://example.com/article",
    "provider": {
      "type": "web"
    }
  }
}
```

For Reddit URLs, `metadata.provider.type` is `reddit`, `siteName` is `Reddit`, and provider details include `subreddit`, `postId`, `commentsIncluded`, and `commentsTotal` when Reddit supplies them.

## Examples

### Markdown

Use Markdown for most LLM workflows:

```json
{
  "url": "https://example.com/deep-work",
  "format": "markdown"
}
```

Example content:

```markdown
# Deep Work in Small Windows

Most calendars are not built for concentration...
```

### HTML

Use HTML when the caller needs the cleaned article structure:

```json
{
  "url": "https://example.com/deep-work",
  "format": "html"
}
```

Example content:

```html
<article><h1>Deep Work in Small Windows</h1><p>Most calendars...</p></article>
```

### Text

Use text when the caller wants compact prose without Markdown or HTML syntax:

```json
{
  "url": "https://example.com/deep-work",
  "format": "text"
}
```

Example content:

```text
Deep Work in Small Windows Most calendars are not built for concentration...
```

### Limit Output

Return only the first 2,000 rendered characters:

```json
{
  "url": "https://example.com/deep-work",
  "format": "markdown",
  "maxChars": 2000
}
```

Disable the rendered output cap:

```json
{
  "url": "https://example.com/deep-work",
  "format": "markdown",
  "maxChars": -1
}
```

Prefer a content-aware excerpt window when a page has boilerplate near the start:

```json
{
  "url": "https://example.com/cooling-centers/maps",
  "format": "markdown",
  "maxChars": 1200,
  "excerptMode": "best"
}
```

### Reddit

Fetch a public Reddit post and top comments:

```json
{
  "url": "https://www.reddit.com/r/test/comments/abc123/example_post/",
  "format": "markdown",
  "maxChars": 8000
}
```

Short Reddit URLs are supported too:

```json
{
  "url": "https://redd.it/abc123",
  "format": "text"
}
```

## URL Policy

The server only accepts `http` and `https` URLs. It blocks local and private network targets by default, including `localhost`, `*.localhost`, loopback addresses, link-local addresses, RFC1918 private IPv4 ranges, unique-local IPv6 addresses, and multicast/reserved address ranges. Redirect targets and DNS-resolved addresses are checked with the same policy.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOW_PRIVATE_HOSTS` | unset | Set to `1`, `true`, or `yes` to allow private and local hosts. Useful for trusted local testing only. |
| `ALLOWED_HOSTS` | unset | Comma-separated exact host allowlist. When set, all other hosts are rejected. |
| `BLOCKED_HOSTS` | unset | Comma-separated exact host blocklist. Blocked hosts are rejected before fetching. |

Examples:

```bash
ALLOWED_HOSTS=docs.example.com npx -y --package github:stefanstr/make-content-parsable -- make-content-parsable
```

```bash
ALLOW_PRIVATE_HOSTS=true npx -y --package github:stefanstr/make-content-parsable -- make-content-parsable
```

## Limits and Tradeoffs

- Requests time out after 10 seconds.
- Redirects are followed manually and capped at 5 redirects.
- Fetched responses are capped at 5 MiB.
- Web pages must return `text/html` or `application/xhtml+xml`.
- Reddit JSON responses must return `application/json` or `text/json`.
- Rendered content is capped at 50,000 characters by default unless `maxChars` is set.
- `maxChars` is applied after rendering, so Markdown, HTML, and text can truncate at different positions.
- `maxChars: -1` disables the rendered output cap but does not disable the 5 MiB fetch cap.
- Reddit extraction includes top-level top comments only, capped at 20 comments.
- Reddit URLs are normalized to `www.reddit.com` JSON endpoints with `raw_json=1`, `sort=top`, and `limit=20`.
- `excerptMode: "best"` is deterministic and local to rendered content; it can skip obvious boilerplate, but it is still a heuristic.
- HTML truncation can cut markup because it truncates the rendered HTML string.

## Why Not Just Fetch?

Unlike simple fetch requests, this server:

- Extracts relevant content using provider-specific parsing
- Eliminates web page noise like ads, popups, and navigation menus
- Handles Reddit URLs through Reddit JSON instead of brittle page scraping
- Reduces token usage by removing unnecessary HTML and CSS
- Provides consistent formatting for better LLM processing
- Includes useful metadata about the content

## Dependencies

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - MCP server support
- [@mozilla/readability](https://github.com/mozilla/readability) - Content extraction
- [turndown](https://github.com/mixmark-io/turndown) - HTML to Markdown conversion
- [jsdom](https://github.com/jsdom/jsdom) - DOM parsing
- [axios](https://github.com/axios/axios) - HTTP requests

## License

MIT
