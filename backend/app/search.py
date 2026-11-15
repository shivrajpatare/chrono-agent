import asyncio
import logging
import re
import time
import urllib.parse
from typing import Any, Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# Try ddgs first, fallback to duckduckgo_search
try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None  # Handled dynamically if missing

# Shared HTTP/2 AsyncClient pool
_http_client: Optional[httpx.AsyncClient] = None

# In-memory query cache: {normalized_query: (epoch_ts, results)}
_search_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

# Provider tracking for telemetry
_last_provider: str = "none"


def get_last_provider() -> str:
    """Return which search provider fulfilled the last request."""
    return _last_provider

# Tracking query parameters to strip during URL normalization
TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "ref_src",
    "fbclid",
    "gclid",
    "msclkid",
    "trk",
}


def get_http_client() -> httpx.AsyncClient:
    """Get or create shared HTTP/2 async client."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(http2=True, timeout=10.0)
    return _http_client


async def close_http_client() -> None:
    """Close the shared HTTP client."""
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


def normalize_url(url: str) -> str:
    """Normalize URL by stripping tracking parameters, fragments, and trailing slashes."""
    try:
        parsed = urllib.parse.urlparse(url.strip())
        query_params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        filtered_params = [
            (k, v)
            for k, v in query_params
            if k.lower() not in TRACKING_PARAMS and not k.lower().startswith("utm_")
        ]
        new_query = urllib.parse.urlencode(filtered_params)
        normalized = urllib.parse.urlunparse(
            (
                parsed.scheme.lower(),
                parsed.netloc.lower(),
                parsed.path.rstrip("/") if parsed.path != "/" else "/",
                parsed.params,
                new_query,
                "",  # remove fragment
            )
        )
        return normalized.rstrip("/")
    except Exception:
        return url.strip().rstrip("/")


def trim_snippet(text: str, max_chars: Optional[int] = None) -> str:
    """Trim snippet text to max_chars, breaking neatly at word boundaries."""
    settings = get_settings()
    limit = max_chars or settings.MAX_SEARCH_SNIPPET_LENGTH
    cleaned = " ".join(text.split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    truncated = cleaned[: limit - 3]
    last_space = truncated.rfind(" ")
    if last_space > limit // 2:
        truncated = truncated[:last_space]
    return truncated + "..."


def get_word_tokens(text: str) -> set[str]:
    """Extract set of lowercase alphanumeric word tokens for similarity computation."""
    return set(re.findall(r"\w+", text.lower()))


def jaccard_similarity(set_a: set[str], set_b: set[str]) -> float:
    """Compute Jaccard similarity between two token sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def deduplicate_results(
    results: list[dict[str, Any]], similarity_threshold: Optional[float] = None
) -> list[dict[str, Any]]:
    """Deduplicate search items by normalized URL and Jaccard snippet similarity."""
    settings = get_settings()
    threshold = similarity_threshold or settings.JACCARD_SIMILARITY_THRESHOLD

    seen_urls: set[str] = set()
    accepted_results: list[dict[str, Any]] = []
    accepted_tokens: list[set[str]] = []

    for item in results:
        norm_url = item.get("normalized_url") or normalize_url(item.get("url", ""))
        if not norm_url or norm_url in seen_urls:
            continue

        snippet = item.get("snippet", "")
        tokens = get_word_tokens(snippet)

        is_dup = False
        for prev_tokens in accepted_tokens:
            if jaccard_similarity(tokens, prev_tokens) > threshold:
                is_dup = True
                break

        if not is_dup:
            seen_urls.add(norm_url)
            accepted_tokens.append(tokens)
            accepted_results.append(
                {
                    "url": norm_url,
                    "title": item.get("title", ""),
                    "snippet": snippet,
                    "published_date": item.get("published_date"),
                }
            )

    return accepted_results


async def _search_tavily(query: str, api_key: str) -> list[dict[str, Any]]:
    """Search using Tavily REST API via shared httpx client."""
    settings = get_settings()
    client = get_http_client()
    url = "https://api.tavily.com/search"
    payload = {
        "api_key": api_key,
        "query": query,
        "search_depth": "basic",
        "max_results": settings.MAX_SEARCH_RESULTS_PER_QUERY,
        "include_answer": False,
        "include_raw_content": False,
    }
    response = await client.post(url, json=payload)
    response.raise_for_status()
    data = response.json()

    raw_results = []
    for item in data.get("results", []):
        raw_results.append(
            {
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "snippet": trim_snippet(item.get("content", "")),
                "published_date": item.get("published_date"),
            }
        )
    return raw_results


def _sync_ddgs_search(query: str) -> list[dict[str, Any]]:
    """Synchronous worker for DDGS search run inside asyncio.to_thread."""
    if DDGS is None:
        raise RuntimeError("Neither 'ddgs' nor 'duckduckgo_search' is installed.")

    ddgs_instance = DDGS(timeout=10)
    raw_items = ddgs_instance.text(query, max_results=5)
    results = []
    for item in raw_items:
        results.append(
            {
                "url": item.get("href") or item.get("link") or "",
                "title": item.get("title", ""),
                "snippet": trim_snippet(item.get("body") or item.get("snippet") or ""),
                "published_date": None,
            }
        )
    return results


async def _search_ddgs(query: str) -> list[dict[str, Any]]:
    """Search DuckDuckGo without blocking the async event loop."""
    return await asyncio.to_thread(_sync_ddgs_search, query)


async def _search_single(query: str) -> list[dict[str, Any]]:
    """Perform single query search with caching, Tavily primary, and DDGS fallback."""
    settings = get_settings()
    norm_query = " ".join(query.strip().lower().split())

    # Check 10-minute TTL cache
    now = time.time()
    if norm_query in _search_cache:
        cached_ts, cached_results = _search_cache[norm_query]
        if now - cached_ts < settings.SEARCH_CACHE_TTL_SECONDS:
            return cached_results

    raw_results: list[dict[str, Any]] = []

    # Try Tavily if API key is configured
    global _last_provider
    if settings.TAVILY_API_KEY and settings.TAVILY_API_KEY.strip():
        try:
            raw_results = await _search_tavily(norm_query, settings.TAVILY_API_KEY.strip())
            if raw_results:
                _last_provider = "tavily"
        except Exception as e:
            logger.warning(
                "Tavily search failed for query '%s' (%s). Falling back cleanly to DuckDuckGo.",
                norm_query,
                e,
            )
            raw_results = []

    # Fallback to DuckDuckGo if Tavily failed or key not configured
    if not raw_results:
        try:
            raw_results = await _search_ddgs(norm_query)
            if raw_results:
                _last_provider = "ddgs"
        except Exception as e:
            logger.error("DDGS fallback search failed for query '%s': %s", norm_query, e)
            raw_results = []

    # Format snippets and URLs
    formatted = []
    for r in raw_results:
        url = normalize_url(r["url"])
        if url:
            formatted.append(
                {
                    "url": url,
                    "normalized_url": url,
                    "title": r.get("title", ""),
                    "snippet": trim_snippet(r.get("snippet", "")),
                    "published_date": r.get("published_date"),
                }
            )

    # Cache results
    _search_cache[norm_query] = (now, formatted)
    return formatted


async def web_search(queries: list[str]) -> list[dict[str, Any]]:
    """Execute parallel search queries concurrently and return deduplicated results."""
    settings = get_settings()
    # Cap parallel queries to at most 3
    clean_queries = [q.strip() for q in queries if q and q.strip()][:3]
    if not clean_queries:
        return []

    # Execute all queries concurrently via asyncio.gather
    results_lists = await asyncio.gather(
        *[_search_single(q) for q in clean_queries], return_exceptions=True
    )

    combined_results: list[dict[str, Any]] = []
    for q, res in zip(clean_queries, results_lists):
        if isinstance(res, Exception):
            logger.error("Error executing web search for '%s': %s", q, res)
            continue
        if isinstance(res, list):
            combined_results.extend(res)

    # Deduplicate by URL and Jaccard snippet similarity (> 0.75)
    deduped = deduplicate_results(combined_results)
    # Cap total sources injected into context to MAX_TOTAL_SEARCH_SOURCES (8)
    return deduped[: settings.MAX_TOTAL_SEARCH_SOURCES]

