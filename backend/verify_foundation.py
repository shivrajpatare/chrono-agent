"""Verification script for Prompt 1: Backend Foundation.

Tests:
1. SQLite WAL mode & Schema Initialization
2. Messages FTS5 synchronization triggers
3. Commitment detection and storage
4. Relative age calculations
5. Temporal context builder (Verbatim, Temporal, FTS5 BM25, Commitments)
6. FTS5 sanitization
7. Telemetry metadata return
8. Web search (Async gather, DDGS/Tavily adapter, 350-char trimming, Jaccard dedup, 10-min cache)
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# Add backend directory to sys.path so app modules import cleanly
BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

# Use isolated test database for verification
TEST_DB_PATH = BACKEND_DIR / "data" / "verify_test.db"
os.environ["DATABASE_PATH"] = str(TEST_DB_PATH)

from app.config import get_settings
from app.memory import (
    build_temporal_context,
    detect_commitments,
    format_relative_age,
    get_db_connection,
    init_db,
    sanitize_fts5_query,
    save_message,
)
from app.search import (
    close_http_client,
    deduplicate_results,
    get_word_tokens,
    jaccard_similarity,
    normalize_url,
    trim_snippet,
    web_search,
)


def test_sqlite_and_wal():
    print("[1/8] Testing SQLite WAL mode and schema initialization...")
    init_db()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("PRAGMA journal_mode;")
        mode = cursor.fetchone()[0]
        assert mode.lower() == "wal", f"Expected WAL mode, got {mode}"

        # Verify tables exist
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = {row[0] for row in cursor.fetchall()}
        expected_tables = {"messages", "session_summaries", "commitments", "messages_fts"}
        for t in expected_tables:
            assert t in tables, f"Expected table '{t}' in database"
    print("  --> PASSED: SQLite WAL mode active and all tables verified.")


def test_fts5_trigger_sync():
    print("[2/8] Testing FTS5 trigger synchronization...")
    session_id = "test_fts_sync_session"
    msg_id = save_message(session_id, "user", "Quantum computing algorithms for cryptography.")

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT rowid, content FROM messages_fts WHERE rowid = ?;", (msg_id,))
        row = cursor.fetchone()
        assert row is not None, "FTS5 row was not inserted via trigger!"
        assert "Quantum computing" in row["content"]

        # Test FTS MATCH query
        cursor.execute(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"quantum\"';"
        )
        match_rows = cursor.fetchall()
        assert any(r[0] == msg_id for r in match_rows), "FTS MATCH failed to locate inserted row"
    print("  --> PASSED: FTS5 trigger sync & full-text search operational.")


def test_commitment_detection():
    print("[3/8] Testing user commitment detection...")
    sample_text = "Thanks for the plan! I will deploy the backend to staging tonight. Also remind me to check the database logs."
    commitments = detect_commitments(sample_text)
    assert len(commitments) >= 2, f"Expected at least 2 commitments, found {commitments}"
    assert any("deploy the backend" in c for c in commitments)
    assert any("check the database logs" in c for c in commitments)

    # Test saving user message auto-saves commitments to DB
    session_id = "test_commitments_session"
    save_message(session_id, "user", "I'll review the pull request by 5pm tomorrow.")
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT commitment_text, status FROM commitments WHERE session_id = ?;", (session_id,))
        rows = cursor.fetchall()
        assert len(rows) >= 1, "Commitment not auto-persisted to commitments table"
        assert "review the pull request" in rows[0]["commitment_text"]
        assert rows[0]["status"] == "active"
    print(f"  --> PASSED: Commitments detected and persisted ({commitments}).")


def test_relative_age_and_fts_sanitization():
    print("[4/8] Testing relative age formatting and FTS5 sanitization...")
    now_ts = 1000000.0
    assert format_relative_age(now_ts - 20, now_ts) == "20s ago"
    assert format_relative_age(now_ts - 240, now_ts) == "4m ago"
    assert format_relative_age(now_ts - 7200, now_ts) == "2h ago"
    assert format_relative_age(now_ts - 172800, now_ts) == "2d ago"

    # FTS5 Sanitization test
    dirty_query = "What did I ask about Python asyncio and SQLite yesterday? Can you show me?"
    sanitized = sanitize_fts5_query(dirty_query)
    assert "?" not in sanitized
    assert "what" not in sanitized.lower()
    assert '"python"' in sanitized
    assert '"asyncio"' in sanitized
    assert '"sqlite"' in sanitized
    assert " OR " in sanitized
    print(f"  --> PASSED: Sanitized FTS query: {sanitized}")


def test_temporal_context_builder():
    print("[5/8] Testing temporal context builder and telemetry metadata...")
    tz = ZoneInfo("Asia/Kolkata")
    now_dt = datetime.now(tz)
    session_id = "test_temporal_session"

    # Insert historical messages with deterministic timestamps
    # Message 1: 2 days ago
    save_message(
        session_id,
        "user",
        "First thing I want to discuss is designing the telemetry system architecture.",
        created_at_dt=now_dt - timedelta(days=2),
    )
    # Message 2: Yesterday
    save_message(
        session_id,
        "assistant",
        "Yesterday we agreed to implement the telemetry collector using SQLite WAL.",
        created_at_dt=now_dt - timedelta(days=1),
    )
    # Message 3: 3 hours ago (earlier today)
    save_message(
        session_id,
        "user",
        "Earlier today I was thinking about indexing the citations table.",
        created_at_dt=now_dt - timedelta(hours=3),
    )
    # Message 4: 15 minutes ago
    save_message(
        session_id,
        "assistant",
        "The citations table indexing will prevent table scans during search.",
        created_at_dt=now_dt - timedelta(minutes=15),
    )
    # Message 5: 5 minutes ago with commitment
    save_message(
        session_id,
        "user",
        "Got it! I promise to write comprehensive tests for this module.",
        created_at_dt=now_dt - timedelta(minutes=5),
    )
    # Message 6: 1 minute ago
    save_message(
        session_id,
        "assistant",
        "I will be ready to review those tests whenever you run them.",
        created_at_dt=now_dt - timedelta(minutes=1),
    )

    # 1. Test "first thing I asked"
    res1 = build_temporal_context(session_id, "What was the first thing I asked you?", now_dt=now_dt)
    assert res1.memory_hits > 0, "Expected non-zero memory hits"
    assert "telemetry system architecture" in res1.context_text
    assert len(res1.recent_turns) > 0
    assert len(res1.active_commitments) >= 1

    # 2. Test "yesterday"
    res2 = build_temporal_context(session_id, "What did we discuss yesterday?", now_dt=now_dt)
    assert "Yesterday we agreed" in res2.context_text

    # 3. Test "earlier today"
    res3 = build_temporal_context(session_id, "What did I mention earlier today?", now_dt=now_dt)
    assert "Earlier today I was thinking" in res3.context_text

    # 4. Test Cross-Session Fallback on new session
    new_session_id = "brand_new_session_99"
    res_fallback = build_temporal_context(
        new_session_id, "What did I ask yesterday about telemetry?", now_dt=now_dt
    )
    assert res_fallback.memory_hits > 0, "Fallback across sessions did not produce memory hits"
    print(f"  --> PASSED: Temporal context builder verified with {res1.memory_hits} telemetry hits.")


def test_jaccard_and_url_normalization():
    print("[6/8] Testing URL normalization, snippet trimming, and Jaccard deduplication...")
    raw_url = "https://example.com/api/v1/search/?utm_source=twitter&utm_medium=cpc&ref=homepage#"
    norm = normalize_url(raw_url)
    assert norm == "https://example.com/api/v1/search"

    long_text = "word " * 100
    trimmed = trim_snippet(long_text, max_chars=350)
    assert len(trimmed) <= 350
    assert trimmed.endswith("...")

    # Jaccard similarity test
    text_a = "FastAPI is a modern fast web framework for building APIs with Python in production and scale."
    text_b = "FastAPI is a modern fast web framework for building APIs with Python in production and scale today."
    text_c = "SQLite is an embedded relational database engine designed for local zero-configuration storage."

    tokens_a = get_word_tokens(text_a)
    tokens_b = get_word_tokens(text_b)
    tokens_c = get_word_tokens(text_c)

    sim_ab = jaccard_similarity(tokens_a, tokens_b)
    sim_ac = jaccard_similarity(tokens_a, tokens_c)
    assert sim_ab > 0.75, f"Expected high similarity between a and b, got {sim_ab}"
    assert sim_ac < 0.3, f"Expected low similarity between a and c, got {sim_ac}"

    test_items = [
        {"url": "https://example.com/page1", "title": "T1", "snippet": text_a},
        {"url": "https://example.com/page2", "title": "T2", "snippet": text_b},  # Should be deduped (>0.75)
        {"url": "https://example.com/page3", "title": "T3", "snippet": text_c},  # Kept
    ]
    deduped = deduplicate_results(test_items, similarity_threshold=0.75)
    assert len(deduped) == 2, f"Expected 2 results after dedup, got {len(deduped)}"
    print("  --> PASSED: URL normalization, trimming, and Jaccard dedup verified.")


async def test_async_web_search():
    print("[7/8] Testing async web_search (concurrent execution and DDGS fallback)...")
    queries = ["python sqlite wal mode", "fastapi async await"]
    results = await web_search(queries)
    assert isinstance(results, list)
    print(f"  --> Web search returned {len(results)} deduplicated results.")
    if results:
        sample = results[0]
        assert "url" in sample
        assert "title" in sample
        assert "snippet" in sample
        assert len(sample["snippet"]) <= 350
        print(f"  --> Sample result: {sample['title']} ({sample['url']})")

    # Test 10-minute cache hit
    print("  --> Testing 10-minute TTL cache hit...")
    start_time = asyncio.get_event_loop().time()
    cached_results = await web_search(["python sqlite wal mode"])
    elapsed = asyncio.get_event_loop().time() - start_time
    assert len(cached_results) > 0
    assert elapsed < 0.1, f"Expected near-instant cache hit, took {elapsed:.3f}s"
    print(f"  --> PASSED: Async web_search and cache verified in {elapsed:.4f}s.")


def cleanup_test_db():
    print("[8/8] Cleaning up test database artifacts...")
    for ext in ["", "-wal", "-shm"]:
        p = Path(f"{TEST_DB_PATH}{ext}")
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass
    print("  --> Cleaned test files.")


async def main():
    print("==================================================")
    print("CHRONO-AGENT BACKEND FOUNDATION VERIFICATION SUITE")
    print("==================================================")
    try:
        test_sqlite_and_wal()
        test_fts5_trigger_sync()
        test_commitment_detection()
        test_relative_age_and_fts_sanitization()
        test_temporal_context_builder()
        test_jaccard_and_url_normalization()
        await test_async_web_search()
        cleanup_test_db()
        print("==================================================")
        print("ALL VERIFICATION CHECKS PASSED SUCCESSFULLY (8/8)!")
        print("==================================================")
    finally:
        await close_http_client()


if __name__ == "__main__":
    asyncio.run(main())

