# Excerpt modes and content-aware truncation

Issue #6 asks whether truncating rendered content from the beginning is good enough. The short answer is no: the current behavior is compatible and predictable, but it can spend the entire returned budget on low-value text when Readability leaves page furniture inside the article body.

## Current behavior

- `maxChars` is applied after rendering the Readability article into the requested format.
- Truncation is a simple `content.slice(0, maxChars)`.
- `metadata.excerpt` is not derived from the returned content window. It remains the excerpt reported by Readability, usually from article metadata or an early summary paragraph.
- Reddit output has its own ordering and should keep start-based truncation unless a Reddit-specific design is introduced later.

Representative fixtures already cover three useful baselines:

- `clean-article.html`: a normal article where the beginning is useful.
- `boilerplate-heavy-intro.html`: page-level chrome is removed by Readability.
- `list-heavy-page.html`: list structure survives rendering and truncation should not flatten intent.

The added `surviving-boilerplate-intro.html` fixture captures the failure mode this design is meant to address: low-value newsletter/share/related text appears inside the article body, so Readability reasonably preserves it and start truncation returns that text before the article's substance.

## Failure patterns

- Leading dek or metadata summaries can repeat `metadata.excerpt` and crowd out the first real paragraph.
- Newsletter, share, sign-in, sponsored, advertisement, cookie, related-story, and read-more blocks can survive if they are embedded in article content.
- List-heavy and table-heavy pages need a window that keeps nearby heading context, not only the single highest scoring line item.
- Some articles begin with setup, disclosure, or recap text while the most useful answer appears in a later explanatory paragraph.

## API recommendation

Add an optional MCP input:

```json
{
  "excerptMode": {
    "type": "string",
    "enum": ["start", "best"],
    "description": "Controls how returned content is selected when maxChars truncates web article output. Defaults to start."
  }
}
```

`"start"` remains the default and exactly preserves today's behavior.

`"best"` applies only when rendered web article content exceeds `maxChars`. If `maxChars` is `-1` or content fits within the limit, return the full rendered content. Keep `metadata.excerpt` unchanged so callers do not lose the Readability-provided summary.

Invalid values should fail MCP argument validation with a stable message:

```text
excerptMode must be one of: start, best
```

## Recommended heuristic

1. Render article content first, using the same `format` path as today.
2. Split rendered content into candidate blocks. For Markdown, split on blank lines and preserve heading/list boundaries where possible. For text, fall back to sentence chunks when rendering has normalized the content into one line. HTML keeps start-style truncation for now because cutting a middle string window can produce invalid markup.
3. Score each block:
   - add signal for sentence-like prose, useful length, non-link text density, and overlap with title keywords.
   - add modest signal for headings that introduce nearby prose.
   - penalize boilerplate terms: subscribe, newsletter, share, advertisement, sponsored, cookie, sign in, related, read more.
   - penalize very early short utility blocks, but do not penalize early normal paragraphs.
4. Select the highest scoring block and build a contiguous window around it, expanding backward for a nearby heading and forward for following prose until `maxChars` is reached.
5. If no block has positive signal, fall back to `"start"`.

This keeps the implementation deterministic, cheap, and local to post-render truncation, while leaving room to improve scoring with more fixtures.

## Implementation tests

- `"start"` produces byte-for-byte equivalent content to current truncation.
- `"best"` skips the surviving boilerplate fixture and includes the substantive planning paragraph within the same `maxChars`.
- `"best"` respects `maxChars: 0`, small positive limits, and `maxChars: -1`.
- Invalid `excerptMode` is rejected before fetching.
- Reddit and HTML output treat `"best"` as `"start"` and document that behavior.
