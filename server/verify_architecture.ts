import { getDb, saveMessage, buildTemporalContext } from "./memory.js";
import { runAgentStream } from "./agent.js";
import { config } from "./config.js";

async function collectAgentResponse(sessionId: string, query: string) {
  let content = "";
  let metrics: any = null;
  const sources: any[] = [];
  const statusEvents: any[] = [];

  for await (const event of runAgentStream(sessionId, query)) {
    if (event.event === "token") {
      content += event.data.text || "";
    } else if (event.event === "sources") {
      sources.push(...event.data);
    } else if (event.event === "metrics") {
      metrics = event.data;
    } else if (event.event === "status") {
      statusEvents.push(event.data);
    }
  }

  return { content, metrics, sources, statusEvents };
}

async function runVerification() {
  console.log("=================================================");
  console.log(" Starting Chrono Agent Architecture Verification ");
  console.log("=================================================");

  const db = getDb();
  // Clean up any stale test sessions from previous runs
  db.prepare(`DELETE FROM commitments WHERE session_id LIKE 'test-%';`).run();
  db.prepare(`DELETE FROM messages WHERE session_id LIKE 'test-%';`).run();

  const testSessionPrefix = `test-ts-${Date.now()}`;
  let passedTests = 0;
  let totalTests = 5;

  try {
    // -------------------------------------------------------------
    // Test 1: In-Session Episodic Recall (Mode A, 0 Searches)
    // -------------------------------------------------------------
    console.log("\n[Test 1/5] In-Session Episodic Recall...");
    const session1 = `${testSessionPrefix}-1`;
    // Seed initial turn
    saveMessage({
      sessionId: session1,
      role: "user",
      content: "What is the capital of France and its population?",
    });
    saveMessage({
      sessionId: session1,
      role: "assistant",
      content: "The capital of France is Paris with an urban population of over 2.1 million.",
    });

    const res1 = await collectAgentResponse(session1, "What was the first thing I asked you in this session?");
    console.log("Agent response:", res1.content.trim());
    console.log(`Telemetry: Searches=${res1.metrics?.search_count}, MemHits=${res1.metrics?.memory_hits}`);

    const pass1 =
      res1.metrics?.search_count === 0 &&
      res1.content.toLowerCase().includes("france") &&
      res1.content.toLowerCase().includes("capital");

    if (pass1) {
      console.log("✓ PASS: In-Session Episodic Recall (0 web searches, accurate recall)");
      passedTests++;
    } else {
      console.error("✗ FAIL: In-Session Episodic Recall failed assertion");
    }

    // -------------------------------------------------------------
    // Test 2: Cross-Session Recall (Mode A, 0 Searches)
    // -------------------------------------------------------------
    console.log("\n[Test 2/5] Cross-Session Recall...");
    const session2 = `${testSessionPrefix}-2`; // Brand new session
    const res2 = await collectAgentResponse(
      session2,
      "What was the first question I asked you earlier across our sessions?"
    );
    console.log("Agent response:", res2.content.trim());
    console.log(`Telemetry: Searches=${res2.metrics?.search_count}, MemHits=${res2.metrics?.memory_hits}`);

    const pass2 =
      res2.metrics?.search_count === 0 &&
      (res2.content.toLowerCase().includes("france") || res2.content.toLowerCase().includes("capital"));

    if (pass2) {
      console.log("✓ PASS: Cross-Session Recall (reached back across sessions with 0 searches)");
      passedTests++;
    } else {
      console.error("✗ FAIL: Cross-Session Recall failed assertion");
    }

    // -------------------------------------------------------------
    // Test 3: Fuzzy Topic / Synonym Recall via Chronological Digest
    // -------------------------------------------------------------
    console.log("\n[Test 3/5] Fuzzy Topic Recall via Chronological Digest...");
    const session3 = `${testSessionPrefix}-3`;
    // Seed turn with a database discussion from 3 days ago
    const threeDaysAgo = Date.now() / 1000 - 3 * 86400;
    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, is_meta)
       VALUES (?, ?, ?, ?, ?, 0);`
    ).run(
      session3,
      "user",
      "Which managed vector database should I use for RAG?",
      new Date(threeDaysAgo * 1000).toISOString(),
      threeDaysAgo
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, is_meta)
       VALUES (?, ?, ?, ?, ?, 0);`
    ).run(
      session3,
      "assistant",
      "I recommend Pinecone, Qdrant Cloud, and Weaviate based on performance and managed cluster stability.",
      new Date((threeDaysAgo + 2) * 1000).toISOString(),
      threeDaysAgo + 2
    );

    const session3Query = `${testSessionPrefix}-3-query`;
    const res3 = await collectAgentResponse(
      session3Query,
      "A few days ago we talked about a database—which ones did you recommend?"
    );
    console.log("Agent response:", res3.content.trim());

    const pass3 =
      res3.metrics?.search_count === 0 &&
      (res3.content.toLowerCase().includes("pinecone") ||
        res3.content.toLowerCase().includes("qdrant") ||
        res3.content.toLowerCase().includes("weaviate"));

    if (pass3) {
      console.log("✓ PASS: Fuzzy Topic Recall via Chronological Digest");
      passedTests++;
    } else {
      console.error("✗ FAIL: Fuzzy Topic Recall failed assertion");
    }

    // -------------------------------------------------------------
    // Test 4: Temporal Bridge (Recall -> Delta Web Verification)
    // -------------------------------------------------------------
    console.log("\n[Test 4/5] Temporal Bridge (Recall Past Shortlist -> Verify Changes)...");
    const session4 = `${testSessionPrefix}-4`;
    const sixDaysAgo = Date.now() / 1000 - 6 * 86400;
    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, is_meta)
       VALUES (?, ?, ?, ?, ?, 0);`
    ).run(
      session4,
      "user",
      "Shortlist 5 CRM tools for a 20-person sales team",
      new Date(sixDaysAgo * 1000).toISOString(),
      sixDaysAgo
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at_iso, epoch_ts, is_meta)
       VALUES (?, ?, ?, ?, ?, 0);`
    ).run(
      session4,
      "assistant",
      "Here is the shortlist: HubSpot, Pipedrive, Close, Zoho CRM, and Freshsales.",
      new Date((sixDaysAgo + 2) * 1000).toISOString(),
      sixDaysAgo + 2
    );

    const session4Query = `${testSessionPrefix}-4-query`;
    const res4 = await collectAgentResponse(
      session4Query,
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
    );
    console.log("Agent response:", res4.content.trim().substring(0, 300) + "...");
    console.log(`Telemetry: Searches=${res4.metrics?.search_count}, Citations=${res4.metrics?.citation_count}`);

    const pass4 =
      (res4.metrics?.search_count ?? 0) > 0 &&
      (res4.content.toLowerCase().includes("hubspot") ||
        res4.content.toLowerCase().includes("crm") ||
        res4.content.toLowerCase().includes("zoho") ||
        res4.content.toLowerCase().includes("pipedrive"));

    if (pass4) {
      console.log("✓ PASS: Temporal Bridge (Recalled shortlist + executed live delta verification)");
      passedTests++;
    } else {
      console.error("✗ FAIL: Temporal Bridge failed assertion");
    }

    // -------------------------------------------------------------
    // Test 5: Parallel Web Search with Inline Citations (Mode B)
    // -------------------------------------------------------------
    console.log("\n[Test 5/5] Parallel Web Search with Guaranteed Citations...");
    const session5 = `${testSessionPrefix}-5`;
    const res5 = await collectAgentResponse(
      session5,
      "Compare Groq LPU inference latency vs traditional Nvidia H100 GPU"
    );
    console.log("Agent response preview:", res5.content.trim().substring(0, 250) + "...");
    console.log(`Telemetry: Searches=${res5.metrics?.search_count}, Cites=${res5.metrics?.citation_count}`);

    const pass5 =
      (res5.metrics?.search_count ?? 0) > 0 &&
      (res5.metrics?.citation_count ?? 0) > 0 &&
      /\[\d+\]/.test(res5.content);

    if (pass5) {
      console.log("✓ PASS: Parallel Web Search with Guaranteed [1] Citations");
      passedTests++;
    } else {
      console.error("✗ FAIL: Parallel Web Search citations failed assertion");
    }

  } finally {
    // Clean up test records
    console.log("\nCleaning up test session artifacts...");
    db.prepare(`DELETE FROM commitments WHERE session_id LIKE ?;`).run(`${testSessionPrefix}%`);
    db.prepare(`DELETE FROM messages WHERE session_id LIKE ?;`).run(`${testSessionPrefix}%`);
  }

  console.log("\n=================================================");
  console.log(` Verification Complete: ${passedTests}/${totalTests} Passed (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log("=================================================");

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
