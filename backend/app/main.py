"""Chrono Agent — FastAPI HTTP server with SSE streaming chat endpoint.

Manages shared httpx client lifecycle, initializes SQLite on startup,
and exposes REST endpoints for chat, sessions, commitments, and health.
"""

import json
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import memory, search
from app.agent import run_agent_stream
from app.config import get_settings
from app.memory import get_current_time, get_db_connection


# --------------------------------------------------------------------------- #
# Lifespan — startup / shutdown
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize DB and shared HTTP client on startup; clean up on shutdown."""
    memory.init_db()
    search.get_http_client()
    yield
    await search.close_http_client()


app = FastAPI(
    title="Chrono Agent API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Request / Response models
# --------------------------------------------------------------------------- #
class ChatRequest(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    message: str


class CommitmentUpdate(BaseModel):
    status: str  # "active", "completed", "dismissed"


# --------------------------------------------------------------------------- #
# POST /api/chat — SSE streaming chat
# --------------------------------------------------------------------------- #
@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    """Stream agent response as Server-Sent Events."""
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    async def event_generator():
        async for event in run_agent_stream(req.session_id, req.message.strip()):
            yield event

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------- #
# GET /api/sessions — list sessions
# --------------------------------------------------------------------------- #
@app.get("/api/sessions")
async def list_sessions():
    """List distinct sessions with their latest message timestamp and human-readable title."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT session_id,
                   MAX(created_at_iso) as last_active,
                   COUNT(*) as message_count
            FROM messages
            GROUP BY session_id
            ORDER BY MAX(epoch_ts) DESC;
            """
        )
        rows = cursor.fetchall()
        result = []
        for r in rows:
            sid = r["session_id"]
            cursor.execute(
                """
                SELECT content FROM messages
                WHERE session_id = ? AND role = 'user'
                ORDER BY epoch_ts ASC LIMIT 1;
                """,
                (sid,),
            )
            first_turn = cursor.fetchone()
            if first_turn and first_turn["content"]:
                raw_text = first_turn["content"].strip().replace("\n", " ")
                title = (raw_text[:38] + "...") if len(raw_text) > 38 else raw_text
            else:
                title = f"Session {sid[:8]}"

            result.append(
                {
                    "session_id": sid,
                    "title": title,
                    "last_active": r["last_active"],
                    "message_count": r["message_count"],
                }
            )
        return result


# --------------------------------------------------------------------------- #
# GET /api/sessions/{session_id}/messages — session message history
# --------------------------------------------------------------------------- #
@app.get("/api/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    """Return all messages for a session, ordered chronologically."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, session_id, role, content, created_at_iso, epoch_ts, citations_json
            FROM messages
            WHERE session_id = ?
            ORDER BY epoch_ts ASC;
            """,
            (session_id,),
        )
        rows = cursor.fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="Session not found")
        return [
            {
                "id": r["id"],
                "session_id": r["session_id"],
                "role": r["role"],
                "content": r["content"],
                "created_at_iso": r["created_at_iso"],
                "citations": json.loads(r["citations_json"] or "[]"),
            }
            for r in rows
        ]


# --------------------------------------------------------------------------- #
# DELETE /api/sessions/{session_id} — delete session
# --------------------------------------------------------------------------- #
@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete all messages and commitments for a session."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM commitments WHERE session_id = ?;", (session_id,))
        cursor.execute("DELETE FROM messages WHERE session_id = ?;", (session_id,))
        conn.commit()
        return {"status": "deleted", "session_id": session_id}


# --------------------------------------------------------------------------- #
# GET /api/commitments — list commitments
# --------------------------------------------------------------------------- #
@app.get("/api/commitments")
async def list_commitments(session_id: Optional[str] = Query(None)):
    """List active commitments, optionally filtered by session."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        if session_id:
            cursor.execute(
                """
                SELECT id, session_id, commitment_text, detected_at_iso, epoch_ts, status
                FROM commitments
                WHERE session_id = ?
                ORDER BY epoch_ts DESC;
                """,
                (session_id,),
            )
        else:
            cursor.execute(
                """
                SELECT id, session_id, commitment_text, detected_at_iso, epoch_ts, status
                FROM commitments
                ORDER BY epoch_ts DESC
                LIMIT 50;
                """
            )
        rows = cursor.fetchall()
        return [
            {
                "id": r["id"],
                "session_id": r["session_id"],
                "commitment_text": r["commitment_text"],
                "detected_at_iso": r["detected_at_iso"],
                "status": r["status"],
            }
            for r in rows
        ]


# --------------------------------------------------------------------------- #
# PATCH /api/commitments/{commitment_id} — update commitment status
# --------------------------------------------------------------------------- #
@app.patch("/api/commitments/{commitment_id}")
async def update_commitment(commitment_id: int, update: CommitmentUpdate):
    """Update a commitment's status (active, completed, dismissed)."""
    valid_statuses = {"active", "completed", "dismissed"}
    if update.status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {valid_statuses}",
        )
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE commitments SET status = ? WHERE id = ?;",
            (update.status, commitment_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Commitment not found")
        conn.commit()
        return {"id": commitment_id, "status": update.status}


# --------------------------------------------------------------------------- #
# GET /api/health — health check
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health_check():
    """Basic health check with DB connectivity test."""
    settings = get_settings()
    now = get_current_time()
    try:
        with get_db_connection() as conn:
            conn.execute("SELECT 1;")
            db_status = "connected"
    except Exception:
        db_status = "error"

    return {
        "status": "ok",
        "db": db_status,
        "timestamp": now.isoformat(),
        "model": settings.PRIMARY_MODEL,
    }

