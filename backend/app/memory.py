import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Generator, Optional
from zoneinfo import ZoneInfo

from app.config import get_settings

# Punctuation & stop words for FTS5 sanitization
PUNCTUATION_REGEX = re.compile(r'[\?\"\-\:\*\(\)\'\+\/\\\\\^\~\[\]\{\}\!\,\;\.]')
FTS_STOPWORDS = {
    "what", "did", "when", "where", "why", "who", "how", "ask", "asked",
    "ago", "yesterday", "earlier", "first", "i", "you", "me", "my", "we",
    "the", "a", "an", "is", "was", "are", "were", "do", "does", "did",
    "in", "on", "at", "to", "for", "of", "and", "or", "tell", "show",
    "give", "thing", "can", "could", "would", "should", "about", "that",
    "this", "with", "have", "had", "has", "be", "been"
}

TEMPORAL_INTENT_KEYWORDS = {
    "earlier", "before", "yesterday", "ago", "first thing",
    "what did i", "when did i", "remind", "promise", "remember",
    "last time", "last session", "prior", "previously", "first turn",
}

COMMITMENT_PATTERNS = [
    re.compile(
        r"\b(?:I will|I'll|I am going to|I'm going to|I plan to|I promise to|remind me to|don't let me forget to)\s+([^.!?\n]{3,120})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:my promise is to|I need to remember to)\s+([^.!?\n]{3,120})",
        re.IGNORECASE,
    ),
]


class TemporalContextResult(dict):
    """Holds formatted temporal context and metadata for live telemetry."""

    @property
    def context_text(self) -> str:
        return self.get("context_text", "")

    @property
    def memory_hits(self) -> int:
        return self.get("memory_hits", 0)

    @property
    def active_commitments(self) -> list:
        return self.get("active_commitments", [])

    @property
    def recent_turns(self) -> list:
        return self.get("recent_turns", [])

    def __str__(self) -> str:
        return self.context_text


def get_current_time(tz: Optional[ZoneInfo] = None) -> datetime:
    """Get current datetime localized to specified timezone."""
    settings = get_settings()
    zone = tz or settings.get_zone_info()
    return datetime.now(zone)


def get_timestamps(dt: Optional[datetime] = None) -> tuple[str, float]:
    """Return ISO-8601 formatted timestamp and float epoch seconds."""
    dt = dt or get_current_time()
    return dt.isoformat(), dt.timestamp()


def format_relative_age(epoch_ts: float, now_epoch: Optional[float] = None) -> str:
    """Calculate relative age from epoch timestamp (e.g., 30s ago, 5m ago, 2h ago, 1d ago)."""
    now_epoch = now_epoch if now_epoch is not None else get_current_time().timestamp()
    diff = max(0.0, now_epoch - epoch_ts)

    if diff < 60:
        return f"{int(diff)}s ago" if diff >= 5 else "<1m ago"
    diff_min = int(diff // 60)
    if diff_min < 60:
        return f"{diff_min}m ago"
    diff_hr = int(diff_min // 60)
    if diff_hr < 24:
        return f"{diff_hr}h ago"
    diff_days = int(diff_hr // 24)
    return f"{diff_days}d ago"


@contextmanager
def get_db_connection() -> Generator[sqlite3.Connection, None, None]:
    """Yield a SQLite connection configured with WAL mode and row factory."""
    settings = get_settings()
    db_path = settings.get_db_path()
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Initialize database tables, FTS5 virtual table, and triggers."""
    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Messages table
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at_iso TEXT NOT NULL,
                epoch_ts REAL NOT NULL,
                citations_json TEXT DEFAULT '[]'
            );
            """
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session_epoch ON messages(session_id, epoch_ts);"
        )

        # FTS5 Virtual Table for messages
        cursor.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                content='messages',
                content_rowid='id'
            );
            """
        )

        # FTS5 Synchronization Triggers
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
            END;
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            """
        )

        # Session Summaries table
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS session_summaries (
                session_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                updated_at_iso TEXT NOT NULL
            );
            """
        )

        # Commitments table
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS commitments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                commitment_text TEXT NOT NULL,
                detected_at_iso TEXT NOT NULL,
                epoch_ts REAL NOT NULL,
                status TEXT DEFAULT 'active',
                source_message_id INTEGER,
                FOREIGN KEY(source_message_id) REFERENCES messages(id) ON DELETE SET NULL
            );
            """
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_commitments_session ON commitments(session_id, status);"
        )

        conn.commit()


def detect_commitments(text: str) -> list[str]:
    """Extract commitments or promises from user messages using regex patterns."""
    extracted = []
    for pattern in COMMITMENT_PATTERNS:
        matches = pattern.findall(text)
        for match in matches:
            cleaned = match.strip(" .!?,;")
            if cleaned and cleaned not in extracted:
                extracted.append(cleaned)
    return extracted


def save_message(
    session_id: str,
    role: str,
    content: str,
    citations: Optional[list] = None,
    created_at_dt: Optional[datetime] = None,
) -> int:
    """Store message, extract user commitments if applicable, and return message id."""
    iso_str, epoch_ts = get_timestamps(created_at_dt)
    citations_json = json.dumps(citations or [])

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, citations_json)
            VALUES (?, ?, ?, ?, ?, ?);
            """,
            (session_id, role, content, iso_str, epoch_ts, citations_json),
        )
        message_id = cursor.lastrowid

        # Track commitments from user turns
        if role.lower() == "user":
            commitments = detect_commitments(content)
            for item in commitments:
                cursor.execute(
                    """
                    INSERT INTO commitments (session_id, commitment_text, detected_at_iso, epoch_ts, status, source_message_id)
                    VALUES (?, ?, ?, ?, 'active', ?);
                    """,
                    (session_id, item, iso_str, epoch_ts, message_id),
                )

        conn.commit()
        return message_id


def sanitize_fts5_query(query: str) -> str:
    """Sanitize query for FTS5 MATCH by stripping punctuation and stop words, joining with OR."""
    cleaned = PUNCTUATION_REGEX.sub(" ", query.lower())
    tokens = [
        tok.strip()
        for tok in cleaned.split()
        if len(tok.strip()) >= 2 and tok.strip() not in FTS_STOPWORDS
    ]
    if not tokens:
        return ""
    # Enclose valid tokens in quotes to avoid FTS5 reserved word syntax errors
    return " OR ".join(f'"{tok}"' for tok in tokens)


def parse_relative_time_query(
    query: str, now_dt: Optional[datetime] = None
) -> Optional[dict[str, Any]]:
    """Resolve temporal phrases in queries to range or target filters."""
    now_dt = now_dt or get_current_time()
    now_epoch = now_dt.timestamp()
    settings = get_settings()
    lower_query = query.lower()

    # 1. "first thing I asked" / "first question" / "first turn"
    if any(
        phrase in lower_query
        for phrase in [
            "first thing i asked",
            "first thing i said",
            "first thing we discussed",
            "first thing",
            "first question",
            "first turn",
            "first prompt",
            "beginning of our conversation",
            "what did i ask first",
            "what was my first question",
            "what was the first thing",
        ]
    ):
        return {"type": "first_turn"}

    # 2. "X minutes ago" or "X mins ago"
    min_match = re.search(r"(\d+)\s*(?:minutes?|mins?)\s*ago", lower_query)
    if min_match:
        minutes = int(min_match.group(1))
        target_ts = now_epoch - (minutes * 60)
        # 5-minute window around target
        return {
            "type": "range",
            "start": target_ts - 300,
            "end": target_ts + 300,
            "description": f"{minutes} minutes ago",
        }

    # 3. "yesterday"
    if "yesterday" in lower_query:
        yesterday_date = now_dt.date() - timedelta(days=1)
        start_dt = datetime(
            yesterday_date.year, yesterday_date.month, yesterday_date.day, 0, 0, 0, tzinfo=now_dt.tzinfo
        )
        end_dt = start_dt + timedelta(days=1)
        return {
            "type": "range",
            "start": start_dt.timestamp(),
            "end": end_dt.timestamp(),
            "description": "yesterday",
        }

    # 4. "earlier today" or "earlier"
    if "earlier today" in lower_query or "earlier" in lower_query:
        today_date = now_dt.date()
        start_dt = datetime(
            today_date.year, today_date.month, today_date.day, 0, 0, 0, tzinfo=now_dt.tzinfo
        )
        # Up to 30 seconds ago to avoid capturing current active turn
        return {
            "type": "range",
            "start": start_dt.timestamp(),
            "end": max(start_dt.timestamp(), now_epoch - 30),
            "description": "earlier today",
        }

    # 5. "last week"
    if "last week" in lower_query:
        return {
            "type": "range",
            "start": now_epoch - (7 * 86400),
            "end": now_epoch,
            "description": "last week",
        }

    return None


def build_temporal_context(
    session_id: str, user_query: str, now_dt: Optional[datetime] = None
) -> TemporalContextResult:
    """Build unified temporal memory context and telemetry metadata.

    Combines:
    (a) Recent verbatim window (last 6 turns with relative age).
    (b) Temporal range recall (explicit temporal query matching with cross-session fallback).
    (c) FTS5 BM25 keyword recall (older turns with cross-session fallback).
    (d) Active user commitments/promises.
    """
    now_dt = now_dt or get_current_time()
    now_epoch = now_dt.timestamp()
    settings = get_settings()

    recent_turns: list[dict] = []
    temporal_matches: list[dict] = []
    fts_matches: list[dict] = []
    active_commitments: list[dict] = []

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Check total messages in current session
        cursor.execute("SELECT COUNT(*) FROM messages WHERE session_id = ?;", (session_id,))
        session_msg_count = cursor.fetchone()[0]

        # Check total messages in entire database (to know if fallback is available)
        cursor.execute("SELECT COUNT(*) FROM messages;")
        total_db_msg_count = cursor.fetchone()[0]

        is_new_session = session_msg_count == 0

        # Check if user query contains explicit temporal or memory intent
        lower_query = user_query.lower()
        temp_filter = parse_relative_time_query(user_query, now_dt)
        has_temporal_intent = (temp_filter is not None) or any(
            kw in lower_query for kw in TEMPORAL_INTENT_KEYWORDS
        )

        # (a) Recent verbatim turns (last 6 turns)
        cursor.execute(
            """
            SELECT id, session_id, role, content, created_at_iso, epoch_ts
            FROM messages
            WHERE session_id = ?
            ORDER BY epoch_ts DESC
            LIMIT 6;
            """,
            (session_id,),
        )
        recent_rows = cursor.fetchall()
        # Sort ascending in chronological order
        for row in reversed(recent_rows):
            age_str = format_relative_age(row["epoch_ts"], now_epoch)
            recent_turns.append(
                {
                    "id": row["id"],
                    "session_id": row["session_id"],
                    "role": row["role"],
                    "content": row["content"],
                    "created_at_iso": row["created_at_iso"],
                    "epoch_ts": row["epoch_ts"],
                    "relative_age": age_str,
                }
            )

        recent_ids = {t["id"] for t in recent_turns}

        # (b) Temporal query resolution
        if temp_filter and (not is_new_session or has_temporal_intent):
            target_session_filter = (session_id,) if not is_new_session else ()
            session_sql = "WHERE session_id = ?" if not is_new_session else ""

            if temp_filter["type"] == "first_turn":
                # ALWAYS query current session_id first for the user's first question (excluding meta-recall questions)
                cursor.execute(
                    """
                    SELECT id, session_id, role, content, created_at_iso, epoch_ts
                    FROM messages
                    WHERE session_id = ? AND role = 'user'
                      AND lower(content) NOT LIKE '%first thing%asked%'
                      AND lower(content) NOT LIKE '%first thing%said%'
                      AND lower(content) NOT LIKE '%what did i ask%'
                      AND lower(content) NOT LIKE '%first question%'
                    ORDER BY epoch_ts ASC
                    LIMIT 1;
                    """,
                    (session_id,),
                )
                first_row = cursor.fetchone()
                is_current_session_match = True

                # Only fall back to other sessions if current session has zero prior user turns
                if not first_row:
                    cursor.execute(
                        """
                        SELECT id, session_id, role, content, created_at_iso, epoch_ts
                        FROM messages
                        WHERE role = 'user'
                          AND lower(content) NOT LIKE '%first thing%asked%'
                          AND lower(content) NOT LIKE '%first thing%said%'
                          AND lower(content) NOT LIKE '%what did i ask%'
                          AND lower(content) NOT LIKE '%first question%'
                        ORDER BY epoch_ts ASC
                        LIMIT 1;
                        """
                    )
                    first_row = cursor.fetchone()
                    is_current_session_match = False

                if first_row:
                    row_dt = datetime.fromtimestamp(first_row["epoch_ts"], tz=settings.get_zone_info())
                    human_time = row_dt.strftime("%I:%M:%S %p IST")
                    rel_age = format_relative_age(first_row["epoch_ts"], now_epoch)
                    label = (
                        "[FIRST QUESTION IN CURRENT SESSION]"
                        if is_current_session_match
                        else "[FIRST QUESTION IN PRIOR SESSION]"
                    )

                    temporal_matches.append(
                        {
                            "id": first_row["id"],
                            "session_id": first_row["session_id"],
                            "role": first_row["role"],
                            "content": first_row["content"],
                            "created_at_iso": first_row["created_at_iso"],
                            "epoch_ts": first_row["epoch_ts"],
                            "relative_age": f"{human_time}, {rel_age}",
                            "match_reason": label,
                        }
                    )

                    # Also fetch the assistant answer to this first question if available
                    cursor.execute(
                        """
                        SELECT id, session_id, role, content, created_at_iso, epoch_ts
                        FROM messages
                        WHERE session_id = ? AND epoch_ts >= ? AND role = 'assistant'
                        ORDER BY epoch_ts ASC
                        LIMIT 1;
                        """,
                        (first_row["session_id"], first_row["epoch_ts"]),
                    )
                    ans_row = cursor.fetchone()
                    if ans_row:
                        ans_dt = datetime.fromtimestamp(ans_row["epoch_ts"], tz=settings.get_zone_info())
                        ans_time = ans_dt.strftime("%I:%M:%S %p IST")
                        ans_age = format_relative_age(ans_row["epoch_ts"], now_epoch)
                        ans_label = (
                            "[FIRST ANSWER IN CURRENT SESSION]"
                            if is_current_session_match
                            else "[FIRST ANSWER IN PRIOR SESSION]"
                        )
                        temporal_matches.append(
                            {
                                "id": ans_row["id"],
                                "session_id": ans_row["session_id"],
                                "role": ans_row["role"],
                                "content": ans_row["content"],
                                "created_at_iso": ans_row["created_at_iso"],
                                "epoch_ts": ans_row["epoch_ts"],
                                "relative_age": f"{ans_time}, {ans_age}",
                                "match_reason": ans_label,
                            }
                        )
            elif temp_filter["type"] == "range":
                if is_new_session:
                    sql = """
                        SELECT id, session_id, role, content, created_at_iso, epoch_ts
                        FROM messages
                        WHERE role = 'user' AND epoch_ts BETWEEN ? AND ?
                        ORDER BY epoch_ts DESC
                        LIMIT 6;
                    """
                    params = (temp_filter["start"], temp_filter["end"])
                else:
                    sql = """
                        SELECT id, session_id, role, content, created_at_iso, epoch_ts
                        FROM messages
                        WHERE session_id = ? AND role = 'user' AND epoch_ts BETWEEN ? AND ?
                        ORDER BY epoch_ts DESC
                        LIMIT 6;
                    """
                    params = (session_id, temp_filter["start"], temp_filter["end"])

                cursor.execute(sql, params)
                matches = cursor.fetchall()

                # If no matches in short/new session, try cross-session fallback if temporal intent
                if not matches and not is_new_session and has_temporal_intent:
                    cursor.execute(
                        """
                        SELECT id, session_id, role, content, created_at_iso, epoch_ts
                        FROM messages
                        WHERE role = 'user' AND epoch_ts BETWEEN ? AND ?
                        ORDER BY epoch_ts DESC
                        LIMIT 6;
                        """,
                        (temp_filter["start"], temp_filter["end"]),
                    )
                    matches = cursor.fetchall()

                for row in matches:
                    temporal_matches.append(
                        {
                            "id": row["id"],
                            "session_id": row["session_id"],
                            "role": row["role"],
                            "content": row["content"],
                            "created_at_iso": row["created_at_iso"],
                            "epoch_ts": row["epoch_ts"],
                            "relative_age": format_relative_age(row["epoch_ts"], now_epoch),
                            "match_reason": temp_filter.get("description", "time range"),
                        }
                    )

        # (c) FTS5 BM25 keyword recall for older history
        sanitized_fts = sanitize_fts5_query(user_query)
        if sanitized_fts:
            excluded_ids = list(recent_ids.union({t["id"] for t in temporal_matches}))
            placeholders = ",".join("?" for _ in excluded_ids) if excluded_ids else "-1"

            if not is_new_session:
                sql = f"""
                    SELECT m.id, m.session_id, m.role, m.content, m.created_at_iso, m.epoch_ts,
                           bm25(messages_fts) as score
                    FROM messages_fts f
                    JOIN messages m ON f.rowid = m.id
                    WHERE messages_fts MATCH ? AND m.session_id = ? AND m.role = 'user' AND m.id NOT IN ({placeholders})
                    ORDER BY score
                    LIMIT 5;
                """
                cursor.execute(sql, [sanitized_fts, session_id] + excluded_ids)
                fts_rows = cursor.fetchall()
            else:
                fts_rows = []

            # Only search cross-session if session has explicit temporal intent
            if not fts_rows and total_db_msg_count > 0 and has_temporal_intent:
                sql = f"""
                    SELECT m.id, m.session_id, m.role, m.content, m.created_at_iso, m.epoch_ts,
                           bm25(messages_fts) as score
                    FROM messages_fts f
                    JOIN messages m ON f.rowid = m.id
                    WHERE messages_fts MATCH ? AND m.role = 'user' AND m.id NOT IN ({placeholders})
                    ORDER BY score
                    LIMIT 5;
                """
                cursor.execute(sql, [sanitized_fts] + excluded_ids)
                fts_rows = cursor.fetchall()

            for row in fts_rows:
                fts_matches.append(
                    {
                        "id": row["id"],
                        "session_id": row["session_id"],
                        "role": row["role"],
                        "content": row["content"],
                        "created_at_iso": row["created_at_iso"],
                        "epoch_ts": row["epoch_ts"],
                        "relative_age": format_relative_age(row["epoch_ts"], now_epoch),
                        "score": round(float(row["score"]), 3),
                    }
                )

        # (d) Active commitments strictly scoped to current session_id
        cursor.execute(
            """
            SELECT id, commitment_text, detected_at_iso, epoch_ts, status
            FROM commitments
            WHERE session_id = ? AND status = 'active'
            ORDER BY epoch_ts DESC
            LIMIT 10;
            """,
            (session_id,),
        )
        c_rows = cursor.fetchall()

        for c in c_rows:
            active_commitments.append(
                {
                    "id": c["id"],
                    "text": c["commitment_text"],
                    "detected_at_iso": c["detected_at_iso"],
                    "relative_age": format_relative_age(c["epoch_ts"], now_epoch),
                    "status": c["status"],
                }
            )

    # Format the context text blocks
    context_sections = []

    # 1. Active commitments block
    if active_commitments:
        lines = ["### Active User Commitments in Current Session:"]
        for c in active_commitments:
            lines.append(f"- \"{c['text']}\" (stated {c['relative_age']})")
        context_sections.append("\n".join(lines))
    else:
        context_sections.append(
            "### Active Commitments in Current Session: NONE (User has not asked for any reminders or stated promises in this session)."
        )

    # 2. Explicit Temporal Recall block
    if temporal_matches:
        lines = ["### Temporal Memory Matches (Time-Referenced):"]
        for t in temporal_matches:
            reason = t.get("match_reason", "")
            if reason.startswith("[FIRST"):
                lines.append(
                    f"- {reason} (at {t['relative_age']}): \"{t['content']}\""
                )
            else:
                lines.append(
                    f"- [{t['created_at_iso']} ({t['relative_age']})] {t['role']}: {t['content']}"
                )
        context_sections.append("\n".join(lines))

    # 3. Recent verbatim turns block
    if recent_turns:
        lines = ["### Recent Conversation Turns:"]
        for r in recent_turns:
            lines.append(
                f"- [{r['created_at_iso']} ({r['relative_age']})] {r['role']}: {r['content']}"
            )
        context_sections.append("\n".join(lines))

    # 4. FTS5 BM25 keyword recall block
    if fts_matches:
        lines = ["### Relevant Past Context (Keyword Recall):"]
        for f in fts_matches:
            lines.append(
                f"- [{f['created_at_iso']} ({f['relative_age']})] {f['role']}: {f['content']}"
            )
        context_sections.append("\n".join(lines))

    context_text = "\n\n".join(context_sections)

    # Total memory hits count for live telemetry
    memory_hits = (
        len(recent_turns)
        + len(temporal_matches)
        + len(fts_matches)
        + len(active_commitments)
    )

    return TemporalContextResult(
        context_text=context_text,
        memory_hits=memory_hits,
        active_commitments=active_commitments,
        recent_turns=recent_turns,
        temporal_matches=temporal_matches,
        fts_matches=fts_matches,
    )

