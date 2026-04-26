# Make Content Parsable

An [model context protocol (MCP)](https://github.com/modelcontextprotocol) server that makes web content easier for LLMs to parse. It extracts clean Markdown, HTML, or text from normal web pages with Mozilla Readability, and it natively handles public Reddit URLs by returning the post plus top comments. [More about MCP](https://modelcontextprotocol.io/introduction).

## Features
- Removes ads, navigation, footers and other non-essential content from regular web pages
- Converts readable content into well-formatted Markdown, HTML, or plain text
- Extracts public Reddit posts and top comments without OAuth
- Returns stable metadata including permalink, provider type, excerpt, byline, and site name
- Handles errors gracefully

## Why Not Just Fetch?
Unlike simple fetch requests, this server:
- Extracts relevant content using provider-specific parsing
- Eliminates web page noise like ads, popups, and navigation menus
- Handles Reddit URLs through Reddit JSON instead of brittle page scraping
- Reduces token usage by removing unnecessary HTML/CSS
- Provides consistent formatting for better LLM processing
- Includes useful metadata about the content

## Installation

### Run from GitHub
```bash
npx -y --package github:stefanstr/make-content-parsable -- make-content-parsable
```

This package is distributed directly from GitHub and is not currently published to the npm registry.

## Tool Reference

### `extract_web_content`
Use this when the user asks the model to read, summarize, quote, analyze, or extract readable content from a web URL. Normal web pages are extracted with Mozilla Readability. Public Reddit URLs are extracted through Reddit JSON and return the post plus top comments.

**Arguments:**
```json
{
  "url": {
    "type": "string",
    "description": "The full URL whose readable content should be extracted.",
    "required": true
  },
  "format": {
    "type": "string",
    "enum": ["html", "markdown", "text"],
    "description": "Optional output format. Use markdown for most LLM workflows. Defaults to markdown."
  },
  "maxChars": {
    "type": "integer",
    "minimum": -1,
    "description": "Optional character limit applied after rendering. Defaults to -1, which means no limit."
  }
}
```

**Returns:**
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

For Reddit URLs, `provider.type` is `reddit`, `siteName` is `Reddit`, `excerpt` is `null` unless Reddit provides a natural excerpt, and provider-specific details such as subreddit, post id, and included comment counts may appear under `metadata.provider`.

## Usage with Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "make-content-parsable": {
      "command": "npx",
      "args": ["-y", "--package", "github:stefanstr/make-content-parsable", "--", "make-content-parsable"]
    }
  }
}
```

The advertised MCP tool is `extract_web_content`.

## Dependencies
- @mozilla/readability - Content extraction
- turndown - HTML to Markdown conversion
- jsdom - DOM parsing
- axios - HTTP requests

## License
MIT
