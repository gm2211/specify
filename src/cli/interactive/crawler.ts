/**
 * src/cli/interactive/crawler.ts — Lightweight page discovery
 *
 * Crawls a base URL to discover pages by following internal links.
 * Uses fetch + basic HTML parsing (no browser required).
 */

export interface DiscoveredPage {
  path: string;
  title: string;
  links: string[];
  apiCalls: string[];
}

/** Crawl a base URL and discover internal pages. */
export async function discoverPages(
  baseUrl: string,
  options: { maxPages?: number; timeout?: number } = {},
): Promise<DiscoveredPage[]> {
  const maxPages = options.maxPages ?? 20;
  const timeout = options.timeout ?? 10000;
  const base = new URL(baseUrl);
  const visited = new Set<string>();
  const toVisit: string[] = [base.pathname];
  const pages: DiscoveredPage[] = [];

  while (toVisit.length > 0 && pages.length < maxPages) {
    const path = toVisit.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);

    try {
      const url = new URL(path, baseUrl).toString();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'Accept': 'text/html' },
      });

      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) continue;

      const html = await response.text();
      const title = extractTitle(html);
      const links = extractLinks(html, base.origin);
      const apiCalls: string[] = []; // Would need JS execution to detect

      pages.push({ path, title, links: links.map(l => new URL(l, baseUrl).pathname), apiCalls });

      // Queue discovered internal links
      for (const link of links) {
        try {
          const linkUrl = new URL(link, baseUrl);
          if (linkUrl.origin === base.origin && !visited.has(linkUrl.pathname)) {
            toVisit.push(linkUrl.pathname);
          }
        } catch {
          // Skip invalid URLs
        }
      }
    } catch {
      // Skip unreachable pages
    }
  }

  return pages;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

function extractLinks(html: string, origin: string): string[] {
  const links: string[] = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    // Skip anchors, javascript:, mailto:, external links
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;

    try {
      const url = new URL(href, origin);
      if (url.origin === origin) {
        links.push(url.pathname);
      }
    } catch {
      // Skip invalid URLs
      if (href.startsWith('/')) {
        links.push(href);
      }
    }
  }

  // Deduplicate
  return [...new Set(links)];
}
