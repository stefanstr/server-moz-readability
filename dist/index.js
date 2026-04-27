#!/usr/bin/env node
import { lookup as dnsLookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
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
const SERVER_VERSION = '2.0.0';
const USER_AGENT = `make-content-parsable/${SERVER_VERSION} (+https://github.com/stefanstr/make-content-parsable)`;
const UNLIMITED_MAX_CHARS = -1;
const DEFAULT_MAX_CHARS = 50_000;
const REDDIT_COMMENT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LABEL = '5 MiB';
const MAX_REDIRECTS = 5;
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const JSON_CONTENT_TYPES = new Set(['application/json', 'text/json']);
const LOCALHOST_NAMES = new Set(['localhost']);
const PRIVATE_ADDRESS_BLOCK_LIST = createPrivateAddressBlockList();

export class PublicError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicError';
  }
}

function createPrivateAddressBlockList() {
  const blockList = new BlockList();

  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('224.0.0.0', 4, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');
  blockList.addAddress('255.255.255.255', 'ipv4');

  blockList.addAddress('::', 'ipv6');
  blockList.addAddress('::1', 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');
  blockList.addSubnet('ff00::', 8, 'ipv6');

  return blockList;
}

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

  if (!Number.isInteger(limit) || limit < UNLIMITED_MAX_CHARS) {
    throw new Error('maxChars must be an integer greater than or equal to -1');
  }

  if (limit === UNLIMITED_MAX_CHARS) {
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

function parseHostList(value) {
  return new Set((value ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean));
}

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function blockListType(address) {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

function parseIpv4MappedIpv6(address) {
  return address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

function isBlockedIpAddress(address) {
  const mappedIpv4 = parseIpv4MappedIpv6(address);
  if (mappedIpv4) {
    return isBlockedIpAddress(mappedIpv4);
  }

  const type = blockListType(address);
  return type ? PRIVATE_ADDRESS_BLOCK_LIST.check(address, type) : false;
}

function isPrivateHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return LOCALHOST_NAMES.has(normalized)
    || normalized.endsWith('.localhost')
    || isBlockedIpAddress(normalized);
}

function validateHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new PublicError('URL must be a valid absolute URL');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const blockedHosts = parseHostList(process.env.BLOCKED_HOSTS);
  const allowedHosts = parseHostList(process.env.ALLOWED_HOSTS);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PublicError('URL must use http or https');
  }

  if (blockedHosts.has(hostname)) {
    throw new PublicError(`Host is blocked by policy: ${hostname}`);
  }

  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new PublicError(`Host is not allowed by policy: ${hostname}`);
  }

  if (!isEnabled(process.env.ALLOW_PRIVATE_HOSTS) && isPrivateHostname(hostname)) {
    throw new PublicError(`Private or local hosts are blocked by policy: ${hostname}`);
  }

  return parsed.toString();
}

function assertAllowedResolvedAddresses(hostname, addresses) {
  if (isEnabled(process.env.ALLOW_PRIVATE_HOSTS)) {
    return;
  }

  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new PublicError(`Private or local hosts are blocked by policy: ${normalizeHostname(hostname)}`);
    }
  }
}

function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true })
    .then(addresses => {
      assertAllowedResolvedAddresses(hostname, addresses);

      if (options?.all) {
        callback(null, addresses);
        return;
      }

      const [firstAddress] = addresses;
      callback(null, firstAddress.address, firstAddress.family);
    })
    .catch(callback);
}

const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

function normalizeContentType(value) {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase();
}

function assertAllowedContentType(response, allowedContentTypes) {
  const contentType = normalizeContentType(response.headers?.['content-type']);

  if (!contentType || !allowedContentTypes.has(contentType)) {
    throw new PublicError('Unsupported response content type');
  }
}

function defaultHttpRequester(url, config) {
  return axios.get(url, config);
}

function isAxiosResponseSizeLimitError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';

  return (axios.isAxiosError(error) || error?.name === 'AxiosError')
    && /maxContentLength size of \d+ exceeded/.test(message);
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

export async function fetchWithPolicy(url, {
  allowedContentTypes,
  responseType = 'text',
  requester = defaultHttpRequester,
  validateUrl = validateHttpUrl,
  maxRedirects = MAX_REDIRECTS
} = {}) {
  let currentUrl = validateUrl(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let response;
    try {
      response = await requester(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT
        },
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        responseType,
        httpAgent,
        httpsAgent,
        validateStatus: status => (status >= 200 && status < 300) || isRedirectStatus(status)
      });
    } catch (error) {
      if (isAxiosResponseSizeLimitError(error)) {
        throw new PublicError(`Response exceeded maximum fetch size of ${MAX_RESPONSE_BYTES_LABEL}`);
      }

      throw error;
    }

    if (isRedirectStatus(response.status)) {
      if (redirectCount === maxRedirects) {
        throw new PublicError('Too many redirects');
      }

      const location = response.headers?.location;
      if (!location) {
        throw new PublicError('Redirect response did not include a Location header');
      }

      currentUrl = validateUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (allowedContentTypes) {
      assertAllowedContentType(response, allowedContentTypes);
    }

    return {
      data: response.data,
      finalUrl: currentUrl,
      headers: response.headers
    };
  }

  throw new PublicError('Too many redirects');
}

function shapeWebResponse(article, url, options = {}) {
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
  constructor({ httpClient = fetchWithPolicy } = {}) {
    this.httpClient = httpClient;
  }

  validateUrl(url) {
    return validateHttpUrl(url);
  }

  async fetchHtml(url) {
    const response = await this.httpClient(url, {
      allowedContentTypes: HTML_CONTENT_TYPES,
      responseType: 'text'
    });

    return response.data;
  }

  extractArticle(html, url) {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      throw new PublicError('Failed to parse web content');
    }

    return article;
  }

  shapeResponse(article, url, options = {}) {
    return shapeWebResponse(article, url, options);
  }

  async fetchArticle(url) {
    try {
      const validatedUrl = this.validateUrl(url);
      const html = await this.fetchHtml(validatedUrl);
      return this.extractArticle(html, validatedUrl);
    } catch (error) {
      if (error instanceof PublicError) {
        throw error;
      }

      throw new PublicError('Failed to fetch web content');
    }
  }

  async fetchAndParse(url, options = {}) {
    const article = await this.fetchArticle(url);
    return this.shapeResponse(article, url, options);
  }
}

function normalizeRedditJsonUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'redd.it') {
    const postId = parsed.pathname.split('/').filter(Boolean)[0];
    if (!postId) {
      throw new PublicError('Reddit short URL must include a post id');
    }

    if (!/^[A-Za-z0-9]+$/.test(postId)) {
      throw new PublicError('Reddit short URL has an invalid post id');
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

function validateRedditJsonHttpUrl(url) {
  const validatedUrl = validateHttpUrl(url);
  const hostname = new URL(validatedUrl).hostname.toLowerCase();

  if (hostname !== 'www.reddit.com') {
    throw new PublicError('Reddit redirects must stay on www.reddit.com');
  }

  return validatedUrl;
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
  constructor({ httpClient = fetchWithPolicy } = {}) {
    this.httpClient = httpClient;
  }

  async fetchRedditPost(url) {
    try {
      const response = await this.httpClient(normalizeRedditJsonUrl(url), {
        allowedContentTypes: JSON_CONTENT_TYPES,
        responseType: 'json',
        validateUrl: validateRedditJsonHttpUrl
      });

      return parseRedditResponse(response.data);
    } catch (error) {
      if (error instanceof PublicError) {
        throw error;
      }

      throw new PublicError('Failed to fetch Reddit content');
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
  version: SERVER_VERSION
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
          description: "Optional maximum number of characters to return after rendering. Defaults to 50000. Use -1 for no limit."
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

  if (typeof args?.url !== 'string' || args.url.trim() === '') {
    throw new McpError(ErrorCode.InvalidParams, "URL is required");
  }

  if (args.format != null && !SUPPORTED_FORMATS.has(args.format)) {
    throw new McpError(ErrorCode.InvalidParams, "format must be one of: html, markdown, text");
  }

  if (args.maxChars != null && (!Number.isInteger(args.maxChars) || args.maxChars < -1)) {
    throw new McpError(ErrorCode.InvalidParams, "maxChars must be an integer greater than or equal to -1");
  }

  try {
    const url = args.url.trim();
    const result = await parser.fetchAndParse(url, {
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
    const message = error instanceof PublicError ? error.message : 'Failed to extract web content';

    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: ${message}`
      }]
    };
  }
});

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function isDirectCliRun(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) {
    return false;
  }

  return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
}

if (isDirectCliRun(import.meta.url)) {
  startServer().catch(error => {
    console.error(`Server failed to start: ${error.message}`);
    process.exit(1);
  });
}
