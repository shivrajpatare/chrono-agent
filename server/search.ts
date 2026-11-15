import { config } from "./config.js";
import { search, SafeSearchType } from "duck-duck-scrape";

export interface SearchResult {
  id: number;
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
  source_engine: string;
}

interface CacheEntry {
  expiresAt: number;
  results: SearchResult[];
}

// 10-minute in-memory LRU query cache
const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function trimSnippet(snippet: string, maxLen = 350): string {
  const clean = (snippet || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + "...";
}

function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) || [];
  return new Set(words);
}

function jaccardSimilarity(s1: string, s2: string): number {
  const set1 = tokenize(s1);
  const set2 = tokenize(s2);
  if (set1.size === 0 || set2.size === 0) return 0.0;
  let intersection = 0;
  for (const w of set1) {
    if (set2.has(w)) intersection++;
  }
  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

// Zero-key HTML fallback for DuckDuckGo if duck-duck-scrape fails
async function fetchDuckDuckGoHtml(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]+class="result__url"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const urls: { url: string; title: string }[] = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null && urls.length < 5) {
      let rawUrl = match[1];
      if (rawUrl.includes("uddg=")) {
        const decoded = decodeURIComponent(rawUrl.split("uddg=")[1].split("&")[0]);
        rawUrl = decoded;
      }
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      urls.push({ url: rawUrl, title });
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < urls.length) {
      snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
    }

    for (let i = 0; i < urls.length; i++) {
      results.push({
        id: i + 1,
        title: urls[i].title || "Web Reference",
        url: urls[i].url,
        snippet: trimSnippet(snippets[i] || urls[i].title),
        source_engine: "duckduckgo_html",
      });
    }

    return results;
  } catch (err) {
    console.warn("Direct DDG HTML fetch error:", err);
    return [];
  }
}

async function searchSingleQuery(query: string): Promise<SearchResult[]> {
  const normalizedKey = query.trim().toLowerCase();
  const cached = queryCache.get(normalizedKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.results;
  }

  let results: SearchResult[] = [];
  let provider = "none";

  // 1. Tavily API (Primary)
  if (config.tavilyApiKey) {
    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.tavilyApiKey,
          query,
          search_depth: "basic",
          max_results: 3,
          include_answer: false,
          include_raw_content: false,
        }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data.results && Array.isArray(data.results)) {
          results = data.results.map((r: any, idx: number) => ({
            id: idx + 1,
            title: r.title || "Web Reference",
            url: r.url || "",
            snippet: trimSnippet(r.content || r.snippet || ""),
            published_date: r.published_date || undefined,
            source_engine: "tavily",
          }));
          provider = "tavily";
        }
      }
    } catch (e) {
      console.warn(`Tavily search failed for "${query}", falling back to DuckDuckGo:`, e);
    }
  }

  // 2. DuckDuckGo Fallback via duck-duck-scrape
  if (results.length === 0) {
    try {
      const ddgRes = await search(query, {
        safeSearch: SafeSearchType.MODERATE,
      });

      if (ddgRes.results && ddgRes.results.length > 0) {
        results = ddgRes.results.slice(0, 3).map((r, idx) => ({
          id: idx + 1,
          title: r.title,
          url: r.url,
          snippet: trimSnippet(r.description || ""),
          source_engine: "duckduckgo",
        }));
        provider = "duckduckgo";
      }
    } catch (e) {
      console.warn(`duck-duck-scrape failed for "${query}", attempting HTML fallback:`, e);
    }
  }

  // 3. Clean Zero-Key HTML fallback if duck-duck-scrape hit VQD/token blocks
  if (results.length === 0) {
    results = await fetchDuckDuckGoHtml(query);
    if (results.length > 0) provider = "duckduckgo_html";
  }

  queryCache.set(normalizedKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    results,
  });

  return results;
}

export async function webSearch(
  queries: string[]
): Promise<{ results: SearchResult[]; provider: string }> {
  // Cap parallel queries to top 3
  const activeQueries = (queries || []).slice(0, 3);
  if (activeQueries.length === 0) {
    return { results: [], provider: "none" };
  }

  // Execute in parallel
  const queryResultSets = await Promise.all(activeQueries.map((q) => searchSingleQuery(q)));

  const flattened: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let primaryProvider = "none";

  for (const set of queryResultSets) {
    for (const item of set) {
      if (item.source_engine !== "none") primaryProvider = item.source_engine;

      // URL deduplication
      if (seenUrls.has(item.url)) continue;

      // Jaccard similarity snippet deduplication (>0.75)
      let isDuplicate = false;
      for (const existing of flattened) {
        if (jaccardSimilarity(existing.snippet, item.snippet) > 0.75) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seenUrls.add(item.url);
        flattened.push(item);
      }
    }
  }

  // Cap final deduplicated sources to at most 8 total per turn
  const capped = flattened.slice(0, 8).map((r, i) => ({
    ...r,
    id: i + 1,
  }));

  return { results: capped, provider: primaryProvider };
}
