"""Live 3-turn end-to-end verification of the Chrono Agent pipeline.

Uses httpx.ASGITransport to run the FastAPI app in-process.
Wraps the test client inside the FastAPI lifespan context manager (safeguard #4)
so init_db() and the shared HTTP/2 client pool initialize properly.
"""

import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

# Add backend to sys.path
import os
BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

# Use dedicated test database
EVAL_DB_PATH = BACKEND_DIR / "data" / "eval_chrono.db"
os.environ["DATABASE_PATH"] = str(EVAL_DB_PATH)

from app.config import get_settings
get_settings.cache_clear()

import httpx

from app.main import app, lifespan
from app.memory import get_db_connection


def parse_sse_events(raw_text: str) -> list[dict]:
    """Parse SSE text into list of {event, data} dicts."""
    events = []
    current_event = None
    current_data_lines = []

    for line in raw_text.split("\n"):
        if line.startswith("event: "):
            current_event = line[7:].strip()
        elif line.startswith("data: "):
            current_data_lines.append(line[6:])
        elif line == "" and current_event is not None:
            data_str = "\n".join(current_data_lines)
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                data = data_str
            events.append({"event": current_event, "data": data})
            current_event = None
            current_data_lines = []

    # Handle trailing event without final blank line
    if current_event is not None and current_data_lines:
        data_str = "\n".join(current_data_lines)
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            data = data_str
        events.append({"event": current_event, "data": data})

    return events


def get_full_text(events: list[dict]) -> str:
    """Concatenate all token event texts into the full response."""
    return "".join(
        ev["data"]["text"] for ev in events
        if ev["event"] == "token" and isinstance(ev["data"], dict) and "text" in ev["data"]
    )


def get_metrics(events: list[dict]) -> dict:
    """Extract the metrics event data."""
    for ev in events:
        if ev["event"] == "metrics" and isinstance(ev["data"], dict):
            return ev["data"]
    return {}


def get_sources(events: list[dict]) -> list:
    """Extract the sources event data."""
    for ev in events:
        if ev["event"] == "sources" and isinstance(ev["data"], list):
            return ev["data"]
    return []


def get_status_events(events: list[dict]) -> list[dict]:
    """Extract all status events."""
    return [ev for ev in events if ev["event"] == "status"]


async def send_chat(client: httpx.AsyncClient, session_id: str, message: str) -> tuple[str, list[dict]]:
    """Send a chat request and return (raw_text, parsed_events)."""
    response = await client.post(
        "/api/chat",
        json={"session_id": session_id, "message": message},
        timeout=60.0,
    )
    assert response.status_code == 200, f"Chat request failed: {response.status_code} {response.text}"
    raw = response.text
    events = parse_sse_events(raw)
    return raw, events


async def run_verification():
    print("=" * 60)
    print("CHRONO-AGENT PROMPT 2 LIVE VERIFICATION (3 turns)")
    print("=" * 60)

    session_id = f"verify-{uuid.uuid4().hex[:8]}"
    all_passed = True

    # Safeguard #4: manually trigger lifespan so init_db() and HTTP client run
    async with lifespan(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:

            # -------------------------------------------------------------- #
            # Turn 1: Web search + commitment
            # -------------------------------------------------------------- #
            print(f"\n[Turn 1/3] Web search + commitment (session: {session_id})")
            turn1_query = (
                "Search the web for the latest SQLite release notes and features this year. "
                "Also remind me to benchmark our FTS5 index tonight."
            )
            print(f"  Query: '{turn1_query}'")
            t1_start = time.perf_counter()
            _, events1 = await send_chat(client, session_id, turn1_query)
            t1_elapsed = (time.perf_counter() - t1_start) * 1000

            text1 = get_full_text(events1)
            metrics1 = get_metrics(events1)
            sources1 = get_sources(events1)
            status1 = get_status_events(events1)

            print(f"  Response length: {len(text1)} chars")
            print(f"  Metrics: {json.dumps(metrics1, indent=2)}")

            # Assertions
            t1_pass = True
            if metrics1.get("search_count", 0) < 1:
                print("  ❌ FAIL: search_count should be >= 1")
                t1_pass = False
            else:
                print(f"  ✅ search_count = {metrics1['search_count']}")

            if "[1]" not in text1:
                print("  ⚠️  WARNING: No [1] citation found in response (model may not have cited)")
            else:
                print(f"  ✅ Citations found: {metrics1.get('citation_count', 0)}")

            if not sources1:
                print("  ❌ FAIL: No sources event received")
                t1_pass = False
            else:
                print(f"  ✅ Sources received: {len(sources1)} items")

            # Check commitment saved
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT commitment_text FROM commitments WHERE session_id = ? AND status = 'active';",
                    (session_id,),
                )
                commitments = cursor.fetchall()
            if commitments:
                print(f"  ✅ Commitment saved: \"{commitments[0]['commitment_text']}\"")
            else:
                print("  ❌ FAIL: No commitment detected and saved")
                t1_pass = False

            print(f"  Turn 1 elapsed: {t1_elapsed:.0f}ms — {'PASSED' if t1_pass else 'FAILED'}")
            if not t1_pass:
                all_passed = False

            # -------------------------------------------------------------- #
            # Turn 2: Temporal recall (no search)
            # -------------------------------------------------------------- #
            print(f"\n[Turn 2/3] Temporal recall — no search expected")
            print("  Query: 'What was the first thing I asked you, when did I ask it, and what did I ask you to remind me to do?'")
            t2_start = time.perf_counter()
            _, events2 = await send_chat(
                client,
                session_id,
                "What was the first thing I asked you, when did I ask it, and what did I ask you to remind me to do?",
            )
            t2_elapsed = (time.perf_counter() - t2_start) * 1000

            text2 = get_full_text(events2)
            metrics2 = get_metrics(events2)

            print(f"  Response length: {len(text2)} chars")
            print(f"  Metrics: {json.dumps(metrics2, indent=2)}")

            t2_pass = True
            if metrics2.get("search_count", 0) != 0:
                print(f"  ⚠️  WARNING: search_count = {metrics2['search_count']} (expected 0 for temporal recall)")
            else:
                print("  ✅ search_count = 0 (no web search for temporal recall)")

            if metrics2.get("memory_hits", 0) < 1:
                print("  ❌ FAIL: memory_hits should be >= 1")
                t2_pass = False
            else:
                print(f"  ✅ memory_hits = {metrics2['memory_hits']}")

            # Check response references WAL/SQLite and benchmark/FTS5
            text2_lower = text2.lower()
            has_wal_ref = any(kw in text2_lower for kw in ["wal", "sqlite", "write-ahead"])
            has_commit_ref = any(kw in text2_lower for kw in ["benchmark", "fts5", "fts", "index"])
            if has_wal_ref:
                print("  ✅ Response references SQLite WAL (first question recall)")
            else:
                print("  ⚠️  WARNING: Response doesn't clearly reference SQLite WAL")
            if has_commit_ref:
                print("  ✅ Response references benchmark/FTS5 commitment")
            else:
                print("  ⚠️  WARNING: Response doesn't clearly reference FTS5 benchmark commitment")

            ttft2 = metrics2.get("ttft_ms", 0)
            print(f"  TTFT: {ttft2:.0f}ms")

            print(f"  Turn 2 elapsed: {t2_elapsed:.0f}ms — {'PASSED' if t2_pass else 'FAILED'}")
            if not t2_pass:
                all_passed = False

            # -------------------------------------------------------------- #
            # Turn 3: Multi-query comparison
            # -------------------------------------------------------------- #
            print(f"\n[Turn 3/3] Multi-query comparison")
            print("  Query: 'Compare Groq LPU inference vs traditional GPU inference latency'")
            t3_start = time.perf_counter()
            _, events3 = await send_chat(
                client,
                session_id,
                "Compare Groq LPU inference vs traditional GPU inference latency",
            )
            t3_elapsed = (time.perf_counter() - t3_start) * 1000

            text3 = get_full_text(events3)
            metrics3 = get_metrics(events3)
            sources3 = get_sources(events3)
            status3 = get_status_events(events3)

            print(f"  Response length: {len(text3)} chars")
            print(f"  Metrics: {json.dumps(metrics3, indent=2)}")

            t3_pass = True
            if metrics3.get("search_count", 0) < 1:
                print("  ❌ FAIL: search_count should be >= 1 for comparison query")
                t3_pass = False
            else:
                print(f"  ✅ search_count = {metrics3['search_count']}")

            if not metrics3.get("model_used"):
                print("  ❌ FAIL: model_used not reported in metrics")
                t3_pass = False
            else:
                print(f"  ✅ model_used = {metrics3['model_used']}")

            if sources3:
                print(f"  ✅ Sources event streamed: {len(sources3)} items")
            else:
                print("  ⚠️  WARNING: No sources event in Turn 3")

            if status3:
                print(f"  ✅ Status events streamed: {len(status3)}")
            else:
                print("  ⚠️  WARNING: No status events in Turn 3")

            provider = metrics3.get("provider", "none")
            print(f"  Provider: {provider}")

            print(f"  Turn 3 elapsed: {t3_elapsed:.0f}ms — {'PASSED' if t3_pass else 'FAILED'}")
            if not t3_pass:
                all_passed = False

            # -------------------------------------------------------------- #
            # Final DB verification
            # -------------------------------------------------------------- #
            print(f"\n{'=' * 60}")
            print("POST-TEST DATABASE VERIFICATION")
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM messages WHERE session_id = ?;",
                    (session_id,),
                )
                msg_count = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT COUNT(*) FROM commitments WHERE session_id = ?;",
                    (session_id,),
                )
                commit_count = cursor.fetchone()[0]

            print(f"  Messages in session: {msg_count} (expected 6: 3 user + 3 assistant)")
            print(f"  Commitments in session: {commit_count} (expected >= 1)")

            if msg_count >= 6:
                print("  ✅ All messages persisted")
            else:
                print(f"  ❌ FAIL: Expected 6 messages, found {msg_count}")
                all_passed = False

            if commit_count >= 1:
                print("  ✅ Commitments persisted")
            else:
                print("  ❌ FAIL: No commitments found")
                all_passed = False

            # -------------------------------------------------------------- #
            # API endpoint verification
            # -------------------------------------------------------------- #
            print(f"\n{'=' * 60}")
            print("REST API ENDPOINT VERIFICATION")

            # Health check
            resp = await client.get("/api/health")
            assert resp.status_code == 200
            health = resp.json()
            print(f"  ✅ GET /api/health -> {health['status']}, db={health['db']}")

            # Sessions list
            resp = await client.get("/api/sessions")
            assert resp.status_code == 200
            sessions = resp.json()
            session_ids = [s["session_id"] for s in sessions]
            if session_id in session_ids:
                print(f"  ✅ GET /api/sessions -> {len(sessions)} sessions, test session found")
            else:
                print(f"  ⚠️  GET /api/sessions -> test session not found in {len(sessions)} sessions")

            # Session messages
            resp = await client.get(f"/api/sessions/{session_id}/messages")
            assert resp.status_code == 200
            msgs = resp.json()
            print(f"  ✅ GET /api/sessions/{{id}}/messages -> {len(msgs)} messages")

            # Commitments
            resp = await client.get(f"/api/commitments?session_id={session_id}")
            assert resp.status_code == 200
            comms = resp.json()
            print(f"  ✅ GET /api/commitments -> {len(comms)} commitments")

            # PATCH commitment (mark first as completed)
            if comms:
                cid = comms[0]["id"]
                resp = await client.patch(f"/api/commitments/{cid}", json={"status": "completed"})
                assert resp.status_code == 200
                print(f"  ✅ PATCH /api/commitments/{cid} -> status=completed")

    # ---- Summary ---- #
    print(f"\n{'=' * 60}")
    if all_passed:
        print("ALL VERIFICATION CHECKS PASSED SUCCESSFULLY!")
    else:
        print("SOME CHECKS FAILED — see details above.")
    print("=" * 60)

    return 0 if all_passed else 1


if __name__ == "__main__":
    exit_code = asyncio.run(run_verification())
    sys.exit(exit_code)
