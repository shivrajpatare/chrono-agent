import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { getDb } from "./memory.js";
import { runAgentStream } from "./agent.js";

const app = express();

app.use(cors());
app.use(express.json());

// 1. Health Probe
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "chrono-agent-ts",
    timestamp: new Date().toISOString(),
    primaryModel: config.primaryModel,
  });
});

// 2. Chat Streaming Endpoint (SSE)
app.post("/api/chat", async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) {
    res.status(400).json({ error: "Missing session_id or message" });
    return;
  }

  // Set SSE Headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    for await (const { event, data } of runAgentStream(session_id, message)) {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      // Flush if supported
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    }
  } catch (err: any) {
    console.error("Agent streaming error:", err);
    res.write(
      `event: token\ndata: ${JSON.stringify({ text: `\n\n⚠️ Error: ${err.message}` })}\n\n`
    );
  } finally {
    res.end();
  }
});

// 3. List Distinct Sessions
app.get("/api/sessions", (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT session_id,
              MAX(created_at_iso) as last_active,
              COUNT(*) as message_count
       FROM messages
       GROUP BY session_id
       ORDER BY MAX(epoch_ts) DESC;`
    )
    .all() as { session_id: string; last_active: string; message_count: number }[];

  const sessions = rows.map((r) => {
    const firstTurn = db
      .prepare(
        `SELECT content FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY epoch_ts ASC LIMIT 1;`
      )
      .get(r.session_id) as { content: string } | undefined;

    let title = `Session ${r.session_id.substring(0, 8)}`;
    if (firstTurn && firstTurn.content) {
      const clean = firstTurn.content.replace(/\s+/g, " ").trim();
      title = clean.length > 38 ? clean.substring(0, 38) + "..." : clean;
    }

    return {
      session_id: r.session_id,
      title,
      last_active: r.last_active,
      message_count: r.message_count,
    };
  });

  res.json(sessions);
});

// 4. Session Message History
app.get("/api/sessions/:id/messages", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY epoch_ts ASC;`
    )
    .all(req.params.id) as any[];

  const messages = rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: r.content,
    created_at_iso: r.created_at_iso,
    citations: r.citations_json ? JSON.parse(r.citations_json) : [],
  }));

  res.json(messages);
});

// 5. Delete Session
app.delete("/api/sessions/:id", (req, res) => {
  const db = getDb();
  const sessionId = req.params.id;

  db.prepare(`DELETE FROM commitments WHERE session_id = ?;`).run(sessionId);
  db.prepare(`DELETE FROM messages WHERE session_id = ?;`).run(sessionId);

  res.json({ success: true, deleted_session_id: sessionId });
});

// 6. Get Commitments
app.get("/api/commitments", (_req, res) => {
  const db = getDb();
  const commitments = db
    .prepare(`SELECT * FROM commitments ORDER BY epoch_ts DESC;`)
    .all();
  res.json(commitments);
});

// 7. Toggle / Update Commitment
app.patch("/api/commitments/:id", (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const commitmentId = req.params.id;

  db.prepare(`UPDATE commitments SET status = ? WHERE id = ?;`).run(
    status || "completed",
    commitmentId
  );

  const updated = db
    .prepare(`SELECT * FROM commitments WHERE id = ?;`)
    .get(commitmentId);

  res.json(updated);
});

// Start Server
app.listen(config.port, () => {
  console.log(`==========================================`);
  console.log(` Chrono Agent TypeScript Server LIVE      `);
  console.log(` Port:     http://127.0.0.1:${config.port} `);
  console.log(` Model:    ${config.primaryModel}           `);
  console.log(` Timezone: ${config.timezone}               `);
  console.log(` Database: ${config.databasePath}           `);
  console.log(`==========================================`);
});
