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
export const TOOL_NAME = 'extract_web_content';
const DEFAULT_MAX_CHARS = -1;
const REDDIT_COMMENT_LIMIT = 20;

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function nullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  const limit = maxChars ?? DEFAULT_MAX_CHARS;

  if (!Number.isInteger(limit) || limit < -1) {
    throw new Error('maxChars must be an integer greater than or equal to -1');
  }

  if (limit === DEFAULT_MAX_CHARS) {
    return { content, truncated: false };
  }

  if (content.length <= limit) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, limit),
    truncated: true
  };
}

function buildMetadata({
  format,
  excerpt = null,
  byline = null,
  siteName = null,
  truncated,
  permalink,
  provider
}) {
  return {
    format,
    excerpt: nullableString(excerpt),
    byline: nullableString(byline),
    siteName: nullableString(siteName),
    truncated,
    permalink,
    provider
  };
}

export function isRedditUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'reddit.com'
      || hostname === 'www.reddit.com'
      || hostname === 'old.reddit.com'
      || hostname === 'redd.it';
  } catch {
    return false;
  }
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
      metadata: buildMetadata({
        format,
        excerpt: article.excerpt,
        byline: article.byline,
        siteName: article.siteName,
        truncated,
        permalink: url,
        provider: { type: 'web' }
      })
    };
  }
}

function normalizeRedditJsonUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'redd.it') {
    const postId = parsed.pathname.split('/').filter(Boolean)[0];
    if (!postId) {
      throw new Error('Reddit short URL must include a post id');
    }

    const jsonUrl = new URL(`https://www.reddit.com/comments/${postId}.json`);
    jsonUrl.searchParams.set('raw_json', '1');
    jsonUrl.searchParams.set('sort', 'top');
    jsonUrl.searchParams.set('limit', String(REDDIT_COMMENT_LIMIT));
    return jsonUrl.toString();
  }

  parsed.hostname = 'www.reddit.com';
  parsed.protocol = 'https:';
  parsed.hash = '';

  if (!parsed.pathname.endsWith('.json')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}.json`;
  }

  parsed.searchParams.set('raw_json', '1');
  parsed.searchParams.set('sort', 'top');
  parsed.searchParams.set('limit', String(REDDIT_COMMENT_LIMIT));
  return parsed.toString();
}

function flattenTopLevelComments(children, limit = REDDIT_COMMENT_LIMIT) {
  const comments = [];

  for (const child of children ?? []) {
    if (comments.length >= limit) {
      break;
    }

    if (child?.kind !== 't1') {
      continue;
    }

    const data = child.data ?? {};
    comments.push({
      author: nullableString(data.author) ? `u/${data.author}` : null,
      body: nullableString(data.body) ?? '',
      permalink: nullableString(data.permalink)
        ? `https://www.reddit.com${data.permalink}`
        : null
    });
  }

  return comments;
}

function parseRedditResponse(payload) {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error('Unexpected Reddit JSON response');
  }

  const post = payload[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new Error('Reddit post was not found');
  }

  const comments = flattenTopLevelComments(payload[1]?.data?.children);
  const permalink = nullableString(post.permalink)
    ? `https://www.reddit.com${post.permalink}`
    : null;

  return {
    title: nullableString(post.title) ?? 'Reddit post',
    body: nullableString(post.selftext) ?? '',
    outboundUrl: post.is_self ? null : nullableString(post.url),
    author: nullableString(post.author) ? `u/${post.author}` : null,
    subreddit: nullableString(post.subreddit),
    postId: nullableString(post.id),
    permalink,
    commentsTotal: Number.isInteger(post.num_comments) ? post.num_comments : null,
    comments
  };
}

function renderRedditMarkdown(post) {
  const lines = [`# ${post.title}`, ''];

  if (post.body) {
    lines.push(post.body, '');
  }

  if (post.outboundUrl) {
    lines.push(`[Linked content](${post.outboundUrl})`, '');
  }

  if (post.comments.length > 0) {
    lines.push('## Top comments', '');

    for (const comment of post.comments) {
      lines.push(`### ${comment.author ?? 'Unknown author'}`, '');
      lines.push(comment.body, '');
    }
  }

  return lines.join('\n').trim();
}

function renderRedditHtml(post) {
  const parts = [`<article>`, `<h1>${escapeHtml(post.title)}</h1>`];

  if (post.body) {
    parts.push(`<div class="reddit-post-body">${escapeHtml(post.body).replaceAll('\n', '<br>')}</div>`);
  }

  if (post.outboundUrl) {
    parts.push(`<p><a href="${escapeHtml(post.outboundUrl)}">Linked content</a></p>`);
  }

  if (post.comments.length > 0) {
    parts.push('<section class="reddit-comments">', '<h2>Top comments</h2>');

    for (const comment of post.comments) {
      parts.push(
        '<article class="reddit-comment">',
        `<h3>${escapeHtml(comment.author ?? 'Unknown author')}</h3>`,
        `<div>${escapeHtml(comment.body).replaceAll('\n', '<br>')}</div>`,
        '</article>'
      );
    }

    parts.push('</section>');
  }

  parts.push('</article>');
  return parts.join('');
}

function renderRedditText(post) {
  const lines = [post.title];

  if (post.body) {
    lines.push(post.body);
  }

  if (post.outboundUrl) {
    lines.push(`Linked content: ${post.outboundUrl}`);
  }

  if (post.comments.length > 0) {
    lines.push('Top comments');

    for (const comment of post.comments) {
      lines.push(comment.author ?? 'Unknown author');
      lines.push(comment.body);
    }
  }

  return normalizeWhitespace(lines.join('\n'));
}

export function renderRedditContent(post, format = 'markdown') {
  switch (format) {
    case 'html':
      return renderRedditHtml(post);
    case 'markdown':
      return renderRedditMarkdown(post);
    case 'text':
      return renderRedditText(post);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export class RedditParser {
  async fetchRedditPost(url) {
    try {
      const response = await axios.get(normalizeRedditJsonUrl(url), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MCPBot/1.0)'
        }
      });

      return parseRedditResponse(response.data);
    } catch (error) {
      throw new Error(`Failed to fetch or parse Reddit content: ${error.message}`);
    }
  }

  async fetchAndParse(url, options = {}) {
    const post = await this.fetchRedditPost(url);
    const format = options.format ?? 'markdown';
    const renderedContent = renderRedditContent(post, format);
    const { content, truncated } = truncateRenderedContent(renderedContent, options.maxChars);

    return {
      title: post.title,
      content,
      metadata: buildMetadata({
        format,
        excerpt: null,
        byline: post.author,
        siteName: 'Reddit',
        truncated,
        permalink: post.permalink ?? url,
        provider: {
          type: 'reddit',
          subreddit: post.subreddit,
          postId: post.postId,
          commentsIncluded: post.comments.length,
          commentsTotal: post.commentsTotal
        }
      })
    };
  }
}

export class WebContentParser {
  constructor({
    websiteParser = new WebsiteParser(),
    redditParser = new RedditParser()
  } = {}) {
    this.websiteParser = websiteParser;
    this.redditParser = redditParser;
  }

  async fetchAndParse(url, options = {}) {
    if (isRedditUrl(url)) {
      return this.redditParser.fetchAndParse(url, options);
    }

    return this.websiteParser.fetchAndParse(url, options);
  }
}

// Create MCP server instance
const server = new Server({
  name: "make-content-parsable",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

const parser = new WebContentParser();

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: TOOL_NAME,
    description: "Use this when the user asks you to read, summarize, quote, analyze, or extract readable content from a web URL. For normal web pages it uses Mozilla Readability to remove ads/navigation/page chrome. For public Reddit URLs it uses Reddit JSON and returns the post plus top comments. Prefer this over generic web fetching when the LLM needs clean rendered content rather than raw HTML.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL whose readable content should be extracted."
        },
        format: {
          type: "string",
          enum: ["html", "markdown", "text"],
          description: "Output format for the extracted content. Use markdown for most LLM workflows. Defaults to markdown."
        },
        maxChars: {
          type: "integer",
          minimum: -1,
          description: "Optional maximum number of characters to return after rendering. Defaults to -1, which means no limit."
        }
      },
      required: ["url"]
    }
  }]
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== TOOL_NAME) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  if (!args?.url) {
    throw new McpError(ErrorCode.InvalidParams, "URL is required");
  }

  if (args.format != null && !SUPPORTED_FORMATS.has(args.format)) {
    throw new McpError(ErrorCode.InvalidParams, "format must be one of: html, markdown, text");
  }

  if (args.maxChars != null && (!Number.isInteger(args.maxChars) || args.maxChars < -1)) {
    throw new McpError(ErrorCode.InvalidParams, "maxChars must be an integer greater than or equal to -1");
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
          metadata: result.metadata
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
