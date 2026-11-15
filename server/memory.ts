import Database from "better-sqlite3";
import * as chrono from "chrono-node";
import { config } from "./config.js";

export interface MessageRecord {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at_iso: string;
  epoch_ts: number;
  parent_message_id?: number | null;
  is_meta: number;
  citations_json?: string | null;
}

export interface TurnPair {
  userTurn: MessageRecord;
  assistantTurn?: MessageRecord;
  relativeAge: string;
  humanTime: string;
  matchReason?: string;
}

export interface CommitmentRecord {
  id: number;
  session_id: string;
  commitment_text: string;
  detected_at_iso: string;
  epoch_ts: number;
  status: "active" | "completed" | "dismissed";
}

export interface TemporalContextResult {
  contextText: string;
  memoryHits: number;
  activeCommitments: CommitmentRecord[];
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  dbInstance = new Database(config.databasePath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");

  // Base Schema
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      epoch_ts REAL NOT NULL,
      parent_message_id INTEGER,
      is_meta INTEGER DEFAULT 0,
      citations_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, epoch_ts);

    CREATE TABLE IF NOT EXISTS commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      commitment_text TEXT NOT NULL,
      detected_at_iso TEXT NOT NULL,
      epoch_ts REAL NOT NULL,
      status TEXT DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_commitments_session ON commitments(session_id, status);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      role,
      content_rowid='id'
    );
  `);

  // Schema Migration Guard (Safeguard #2)
  const columns = dbInstance
    .prepare("PRAGMA table_info(messages);")
    .all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has("parent_message_id")) {
    dbInstance.exec("ALTER TABLE messages ADD COLUMN parent_message_id INTEGER;");
  }
  if (!colNames.has("is_meta")) {
    dbInstance.exec("ALTER TABLE messages ADD COLUMN is_meta INTEGER DEFAULT 0;");
  }

  // Ensure FTS5 sync triggers exist
  dbInstance.exec(`
    DROP TRIGGER IF EXISTS trg_messages_ad;
    DROP TRIGGER IF EXISTS trg_messages_au;
    DROP TRIGGER IF EXISTS trg_messages_ai;

    CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, role) VALUES (new.id, new.content, new.role);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
      INSERT INTO messages_fts(rowid, content, role) VALUES (new.id, new.content, new.role);
    END;
  `);

  return dbInstance;
}

// Format relative age from epoch seconds (e.g. "30s ago", "4m ago", "2h ago", "12d ago")
export function formatRelativeAge(epochTs: number, nowEpoch: number = Date.now() / 1000): string {
  const diffSec = Math.max(0, Math.floor(nowEpoch - epochTs));
  if (diffSec < 60) return diffSec >= 5 ? `${diffSec}s ago` : "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

// Format localized IST timestamp
export function formatIstTime(epochTs: number): string {
  const date = new Date(epochTs * 1000);
  return date.toLocaleString("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " IST";
}

// Layer 1: Detect pure meta-recall questions at write time
export function isMetaRecallQuery(text: string): boolean {
  const lower = text.toLowerCase();
  const metaPhrases = [
    "what was the first thing",
    "first thing i asked",
    "first thing i said",
    "first question",
    "what did i ask",
    "what did i say",
    "when did i ask",
    "what was my first question",
    "did i ask you earlier",
    "remind me what i asked",
    "what was the second thing",
    "what was the third thing",
    "beginning of our conversation",
  ];
  return metaPhrases.some((phrase) => lower.includes(phrase));
}

// Layer 2: Universal Natural Language Temporal Parser with Past-Preference (Safeguard #3)
export interface ParsedTimeFilter {
  type: "range" | "ordinal";
  startEpoch?: number;
  endEpoch?: number;
  ordinalIndex?: number; // 0 for first, 1 for second, -1 for last
  description: string;
}

export function parseNaturalLanguageTime(
  query: string,
  now: Date = new Date()
): ParsedTimeFilter | null {
  const lower = query.toLowerCase();

  // 1. Check Ordinal / Positional references
  if (
    lower.includes("first question") ||
    lower.includes("first thing") ||
    lower.includes("first prompt") ||
    lower.includes("what did i ask first")
  ) {
    return { type: "ordinal", ordinalIndex: 0, description: "first question" };
  }
  if (lower.includes("second question") || lower.includes("second thing")) {
    return { type: "ordinal", ordinalIndex: 1, description: "second question" };
  }
  if (lower.includes("third question") || lower.includes("third thing")) {
    return { type: "ordinal", ordinalIndex: 2, description: "third question" };
  }
  if (lower.includes("last question") || lower.includes("previous question") || lower.includes("latest question")) {
    return { type: "ordinal", ordinalIndex: -1, description: "previous question" };
  }

  // 2. Relative offset regex ("X minutes/hours/days/weeks ago")
  const offsetMatch = lower.match(/(\d+)\s*(mins?|minutes?|hours?|hrs?|days?|weeks?|months?)\s*ago/);
  if (offsetMatch) {
    const num = parseInt(offsetMatch[1], 10);
    const unit = offsetMatch[2];
    let seconds = 0;
    if (unit.startsWith("min")) seconds = num * 60;
    else if (unit.startsWith("hour") || unit.startsWith("hr")) seconds = num * 3600;
    else if (unit.startsWith("day")) seconds = num * 86400;
    else if (unit.startsWith("week")) seconds = num * 7 * 86400;
    else if (unit.startsWith("month")) seconds = num * 30 * 86400;

    const center = (now.getTime() / 1000) - seconds;
    const padding = Math.max(300, seconds * 0.2); // adaptive window
    return {
      type: "range",
      startEpoch: center - padding,
      endEpoch: center + padding,
      description: `${num} ${unit} ago`,
    };
  }

  // 3. Chrono-node natural language date parsing with past-preference
  const parsed = chrono.parse(query, now);
  if (parsed.length > 0) {
    const first = parsed[0];
    let startDate = first.start.date();
    let endDate = first.end ? first.end.date() : new Date(startDate.getTime() + 86400000);

    // Past-Preferring Date Resolution (Safeguard #3)
    if (startDate.getTime() > now.getTime()) {
      // If weekday match was interpreted in the future (e.g. "on Monday"), shift back 7 days
      if (first.start.isCertain("weekday") && !first.start.isCertain("day")) {
        startDate = new Date(startDate.getTime() - 7 * 86400000);
        endDate = new Date(endDate.getTime() - 7 * 86400000);
      } else {
        // Shift back 1 year for calendar dates (e.g., "3 November")
        startDate.setFullYear(startDate.getFullYear() - 1);
        endDate.setFullYear(endDate.getFullYear() - 1);
      }
    }

    // Expand single-point match to full day window (00:00:00 to 23:59:59 IST)
    const startDay = new Date(startDate);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(endDate);
    endDay.setHours(23, 59, 59, 999);

    return {
      type: "range",
      startEpoch: startDay.getTime() / 1000,
      endEpoch: endDay.getTime() / 1000,
      description: first.text,
    };
  }

  return null;
}

// Commitment extraction patterns
const COMMITMENT_REGEX =
  /\b(?:I will|I'll|I am going to|I'm going to|I plan to|I promise to|remind me to|don't let me forget to)\s+([^.!?\n]{3,120})/i;

export function detectCommitments(sessionId: string, userText: string): CommitmentRecord[] {
  const match = userText.match(COMMITMENT_REGEX);
  if (!match) return [];

  const commitmentText = match[1].trim();
  const db = getDb();
  const now = new Date();
  const epochTs = now.getTime() / 1000;
  const iso = now.toISOString();

  const info = db
    .prepare(
      `INSERT INTO commitments (session_id, commitment_text, detected_at_iso, epoch_ts, status)
       VALUES (?, ?, ?, ?, 'active');`
    )
    .run(sessionId, commitmentText, iso, epochTs);

  return [
    {
      id: Number(info.lastInsertRowid),
      session_id: sessionId,
      commitment_text: commitmentText,
      detected_at_iso: iso,
      epoch_ts: epochTs,
      status: "active",
    },
  ];
}

// Retrieve full (User Question + Assistant Answer) turn pair
function getTurnPair(userTurn: MessageRecord): TurnPair {
  const db = getDb();
  const assistantTurn = db
    .prepare(
      `SELECT * FROM messages 
       WHERE (parent_message_id = ? OR (session_id = ? AND role = 'assistant' AND epoch_ts >= ?))
       ORDER BY epoch_ts ASC LIMIT 1;`
    )
    .get(userTurn.id, userTurn.session_id, userTurn.epoch_ts) as MessageRecord | undefined;

  return {
    userTurn,
    assistantTurn,
    relativeAge: formatRelativeAge(userTurn.epoch_ts),
    humanTime: formatIstTime(userTurn.epoch_ts),
  };
}

// Layer 4: Always-On Compact Chronological Digest (~200-300 tokens)
export function buildChronologicalDigest(limit = 15): string {
  const db = getDb();
  // Get historical non-meta user turns
  const userTurns = db
    .prepare(
      `SELECT * FROM messages
       WHERE role = 'user' AND is_meta = 0
       ORDER BY epoch_ts DESC LIMIT ?;`
    )
    .all(limit) as MessageRecord[];

  if (userTurns.length === 0) return "No prior conversation history recorded.";

  // Chronological order (oldest to newest)
  userTurns.reverse();
  const lines: string[] = [];

  for (const u of userTurns) {
    const pair = getTurnPair(u);
    const timeStr = formatIstTime(u.epoch_ts);
    const ageStr = formatRelativeAge(u.epoch_ts);
    const userSummary = u.content.replace(/\s+/g, " ").trim().substring(0, 60);
    const assistantSummary = pair.assistantTurn
      ? pair.assistantTurn.content.replace(/\s+/g, " ").trim().substring(0, 80) + "..."
      : "In progress";

    lines.push(
      `• [${timeStr} (${ageStr}) | Session ${u.session_id.substring(0, 8)}] Q: "${userSummary}" -> A: "${assistantSummary}"`
    );
  }

  return lines.join("\n");
}

// Main Pre-Turn Temporal Context Builder
export function buildTemporalContext(
  sessionId: string,
  userQuery: string
): TemporalContextResult {
  const db = getDb();
  const now = new Date();
  const nowEpoch = now.getTime() / 1000;
  let memoryHits = 0;

  // 1. Verbatim current session window (last 6 turns)
  const currentSessionTurns = db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY epoch_ts DESC LIMIT 6;`
    )
    .all(sessionId) as MessageRecord[];
  currentSessionTurns.reverse();

  // 2. Universal Natural Language Temporal Parsing
  const matchedTurnPairs: TurnPair[] = [];
  const timeFilter = parseNaturalLanguageTime(userQuery, now);

  if (timeFilter) {
    if (timeFilter.type === "ordinal") {
      let userTurn: MessageRecord | undefined;
      // Look in current session first
      if (timeFilter.ordinalIndex === 0) {
        userTurn = db
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ? AND role = 'user' AND is_meta = 0
             ORDER BY epoch_ts ASC LIMIT 1;`
          )
          .get(sessionId) as MessageRecord | undefined;
      } else if (timeFilter.ordinalIndex === 1) {
        userTurn = db
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ? AND role = 'user' AND is_meta = 0
             ORDER BY epoch_ts ASC LIMIT 1 OFFSET 1;`
          )
          .get(sessionId) as MessageRecord | undefined;
      } else if (timeFilter.ordinalIndex === -1) {
        userTurn = db
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ? AND role = 'user' AND is_meta = 0
             ORDER BY epoch_ts DESC LIMIT 1;`
          )
          .get(sessionId) as MessageRecord | undefined;
      }

      // Cross-session fallback if current session has no user turns
      if (!userTurn) {
        if (timeFilter.ordinalIndex === 0) {
          userTurn = db
            .prepare(
              `SELECT * FROM messages
               WHERE role = 'user' AND is_meta = 0
               ORDER BY epoch_ts ASC LIMIT 1;`
            )
            .get() as MessageRecord | undefined;
        } else if (timeFilter.ordinalIndex === 1) {
          userTurn = db
            .prepare(
              `SELECT * FROM messages
               WHERE role = 'user' AND is_meta = 0
               ORDER BY epoch_ts ASC LIMIT 1 OFFSET 1;`
            )
            .get() as MessageRecord | undefined;
        }
      }

      if (userTurn) {
        const pair = getTurnPair(userTurn);
        pair.matchReason = `[EXACT MATCH: ${timeFilter.description.toUpperCase()}]`;
        matchedTurnPairs.push(pair);
        memoryHits++;
      }
    } else if (timeFilter.type === "range" && timeFilter.startEpoch && timeFilter.endEpoch) {
      const userTurns = db
        .prepare(
          `SELECT * FROM messages
           WHERE role = 'user' AND is_meta = 0 AND epoch_ts BETWEEN ? AND ?
           ORDER BY epoch_ts DESC LIMIT 4;`
        )
        .all(timeFilter.startEpoch, timeFilter.endEpoch) as MessageRecord[];

      for (const u of userTurns) {
        const pair = getTurnPair(u);
        pair.matchReason = `[DATE MATCH: ${timeFilter.description}]`;
        matchedTurnPairs.push(pair);
        memoryHits++;
      }
    }
  }

  // 3. FTS5 BM25 Keyword Search for entities & topics across historical non-meta turns
  const sanitizedFts = userQuery
    .replace(/[\?\"\-\:\*\(\)\'\+\/\\\\\^\~\[\]\{\}\!\,\;\.]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(what|when|where|which|who|whom|this|that|with|have|from|tell|show|were|does|first|second|last)$/i.test(w))
    .map((w) => `"${w}"`)
    .join(" OR ");

  if (sanitizedFts) {
    try {
      const ftsMatches = db
        .prepare(
          `SELECT m.*, bm25(messages_fts) as score
           FROM messages_fts f
           JOIN messages m ON f.rowid = m.id
           WHERE messages_fts MATCH ? AND m.role = 'user' AND m.is_meta = 0
           ORDER BY score ASC LIMIT 3;`
        )
        .all(sanitizedFts) as MessageRecord[];

      for (const m of ftsMatches) {
        if (!matchedTurnPairs.some((p) => p.userTurn.id === m.id)) {
          const pair = getTurnPair(m);
          pair.matchReason = "[KEYWORD/TOPIC RECALL]";
          matchedTurnPairs.push(pair);
          memoryHits++;
        }
      }
    } catch (e) {
      // Ignore FTS syntax errors
    }
  }

  // 4. Commitments scoped to current session (or explicit cross-session reminders)
  const isAskingAboutPromises =
    userQuery.toLowerCase().includes("remind") ||
    userQuery.toLowerCase().includes("promise") ||
    userQuery.toLowerCase().includes("commitment");

  const commitmentsQuery = isAskingAboutPromises
    ? `SELECT * FROM commitments WHERE status = 'active' ORDER BY epoch_ts DESC LIMIT 5;`
    : `SELECT * FROM commitments WHERE session_id = ? AND status = 'active' ORDER BY epoch_ts DESC LIMIT 5;`;

  const activeCommitments = (
    isAskingAboutPromises ? db.prepare(commitmentsQuery).all() : db.prepare(commitmentsQuery).all(sessionId)
  ) as CommitmentRecord[];

  // Construct Structured <temporal_memory> Context
  const sections: string[] = [];

  // Section A: Always-On Chronological Timeline Digest
  const digest = buildChronologicalDigest(15);
  sections.push(`### Chronological Timeline Digest of Past Inquiries:\n${digest}`);

  // Section B: Deep Matched Turn Pairs (If any)
  if (matchedTurnPairs.length > 0) {
    const pairLines: string[] = [];
    for (const p of matchedTurnPairs) {
      pairLines.push(
        `${p.matchReason || "[MATCHED TURN]"} (${p.humanTime}, ${p.relativeAge}):\n` +
          `  User Asked: "${p.userTurn.content}"\n` +
          (p.assistantTurn ? `  Assistant Answered: "${p.assistantTurn.content}"` : "")
      );
    }
    sections.push(`### Deep Recall of Referent Historical Turn Pairs:\n${pairLines.join("\n\n")}`);
  }

  // Section C: Current Session Recent Turns
  if (currentSessionTurns.length > 0) {
    const recentLines = currentSessionTurns.map(
      (t) => `[${formatIstTime(t.epoch_ts)} (${formatRelativeAge(t.epoch_ts)})] ${t.role}: ${t.content}`
    );
    sections.push(`### Recent Conversation Turns in Current Session:\n${recentLines.join("\n")}`);
  }

  // Section D: Active Commitments
  if (activeCommitments.length > 0) {
    const comLines = activeCommitments.map(
      (c) => `- "${c.commitment_text}" (stated in session ${c.session_id.substring(0, 8)}, ${formatRelativeAge(c.epoch_ts)})`
    );
    sections.push(`### Active User Commitments:\n${comLines.join("\n")}`);
  } else {
    sections.push(
      `### Active Commitments in Current Session: NONE (User has not set any reminders in this session).`
    );
  }

  return {
    contextText: sections.join("\n\n"),
    memoryHits,
    activeCommitments,
  };
}

// Save Turn to Database
export function saveMessage(params: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  parentMessageId?: number | null;
  citations?: any[];
}): MessageRecord {
  const db = getDb();
  const now = new Date();
  const epochTs = now.getTime() / 1000;
  const iso = now.toISOString();
  const isMeta = params.role === "user" ? (isMetaRecallQuery(params.content) ? 1 : 0) : 0;
  const citationsJson = params.citations ? JSON.stringify(params.citations) : null;

  const info = db
    .prepare(
      `INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, parent_message_id, is_meta, citations_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
    )
    .run(
      params.sessionId,
      params.role,
      params.content,
      iso,
      epochTs,
      params.parentMessageId || null,
      isMeta,
      citationsJson
    );

  return {
    id: Number(info.lastInsertRowid),
    session_id: params.sessionId,
    role: params.role,
    content: params.content,
    created_at_iso: iso,
    epoch_ts: epochTs,
    parent_message_id: params.parentMessageId,
    is_meta: isMeta,
    citations_json: citationsJson,
  };
}
