#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

// Initialize HTML to Markdown converter
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

const SUPPORTED_FORMATS = new Set(['html', 'markdown', 'text']);

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function renderTextFromHtml(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  return normalizeWhitespace(dom.window.document.body.textContent ?? '');
}

export function renderArticleContent(article, format = 'markdown') {
  switch (format) {
    case 'html':
      return article.content;
    case 'markdown':
      return turndownService.turndown(article.content);
    case 'text':
      return renderTextFromHtml(article.content);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export function truncateRenderedContent(content, maxChars) {
  if (maxChars == null) {
    return { content, truncated: false };
  }

  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error('maxChars must be a non-negative integer');
  }

  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, maxChars),
    truncated: true
  };
}

export class WebsiteParser {
  async fetchArticle(url) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MCPBot/1.0)'
        }
      });

      const dom = new JSDOM(response.data, { url });
      const document = dom.window.document;
      const reader = new Readability(document);
      const article = reader.parse();

      if (!article) {
        throw new Error('Failed to parse content');
      }

      return article;
    } catch (error) {
      throw new Error(`Failed to fetch or parse content: ${error.message}`);
    }
  }

  async fetchAndParse(url, options = {}) {
    const article = await this.fetchArticle(url);
    const format = options.format ?? 'markdown';
    const renderedContent = renderArticleContent(article, format);
    const { content, truncated } = truncateRenderedContent(renderedContent, options.maxChars);

    return {
      title: article.title,
      content,
      format,
      excerpt: article.excerpt,
      byline: article.byline,
      siteName: article.siteName,
      truncated
    };
  }
}

// Create MCP server instance
const server = new Server({
  name: "server-readability-parser",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

const parser = new WebsiteParser();

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "parse",
    description: "Extracts and transforms webpage content into clean, LLM-optimized Markdown. Returns article title, main content, excerpt, byline and site name. Uses Mozilla's Readability algorithm to remove ads, navigation, footers and non-essential elements while preserving the core content structure.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The website URL to parse"
        },
        format: {
          type: "string",
          enum: ["html", "markdown", "text"],
          description: "Output format for the parsed article content. Defaults to markdown."
        },
        maxChars: {
          type: "integer",
          minimum: 0,
          description: "Optional maximum number of characters to return after rendering."
        }
      },
      required: ["url"]
    }
  }]
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "parse") {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  if (!args?.url) {
    throw new McpError(ErrorCode.InvalidParams, "URL is required");
  }

  if (args.format != null && !SUPPORTED_FORMATS.has(args.format)) {
    throw new McpError(ErrorCode.InvalidParams, "format must be one of: html, markdown, text");
  }

  if (args.maxChars != null && (!Number.isInteger(args.maxChars) || args.maxChars < 0)) {
    throw new McpError(ErrorCode.InvalidParams, "maxChars must be a non-negative integer");
  }

  try {
    const result = await parser.fetchAndParse(args.url, {
      format: args.format,
      maxChars: args.maxChars
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          title: result.title,
          content: result.content,
          metadata: {
            format: result.format,
            excerpt: result.excerpt,
            byline: result.byline,
            siteName: result.siteName,
            truncated: result.truncated
          }
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }]
    };
  }
});

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(error => {
    console.error(`Server failed to start: ${error.message}`);
    process.exit(1);
  });
}
