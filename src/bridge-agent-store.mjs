// Persistent per-session agent state for the SDK bridge. Survives service
// restarts so the bridge can Agent.resume() a warm Cursor agent (keeping its
// server-side prompt cache) instead of re-sending the whole transcript.
//
// Budgets (receipts):
// - Per-row prompt cap mirrors session-index.ts MAX_STORED_TRANSCRIPT_BYTES:
//   a 200k-token rho session is ~1 MiB of prompt text; 8 MiB leaves headroom.
// - Total cap mirrors session-index.ts MAX_TOTAL_TRANSCRIPT_BYTES. Oldest rows
//   are LRU-evicted by updated_at once the sum of stored prompts exceeds it.
const MAX_ROW_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_PROMPT_BYTES = 128 * 1024 * 1024;

/**
 * Open (or create) the sqlite-backed agent store at `file`. Returns an object
 * with get/put/updatePrompt/delete/close. Throws if node:sqlite is unavailable
 * or the file cannot be opened; callers should degrade to in-memory only.
 */
export async function openAgentStore(file, options = {}) {
  const maxTotalPromptBytes = options.maxTotalPromptBytes ?? MAX_TOTAL_PROMPT_BYTES;
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      cache_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      mcp_token TEXT NOT NULL,
      full_prompt TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `);

  const getStmt = db.prepare("SELECT agent_id, mcp_token, full_prompt FROM agents WHERE cache_key = ?");
  const putStmt = db.prepare(
    "INSERT INTO agents (cache_key, agent_id, mcp_token, full_prompt, updated_at) VALUES (?, ?, ?, ?, ?) " +
      // A new agent identity has ingested nothing yet: reset full_prompt so a
      // later resume never derives a bogus delta from the old agent's prompt.
      "ON CONFLICT(cache_key) DO UPDATE SET agent_id = excluded.agent_id, mcp_token = excluded.mcp_token, full_prompt = '', updated_at = excluded.updated_at"
  );
  const updatePromptStmt = db.prepare("UPDATE agents SET full_prompt = ?, updated_at = ? WHERE cache_key = ?");
  const deleteStmt = db.prepare("DELETE FROM agents WHERE cache_key = ?");
  const totalStmt = db.prepare("SELECT COALESCE(SUM(LENGTH(full_prompt)), 0) AS total FROM agents");
  const oldestStmt = db.prepare("SELECT cache_key FROM agents ORDER BY updated_at ASC LIMIT 1");

  function evictOverBudget() {
    for (;;) {
      const total = Number(totalStmt.get()?.total ?? 0);
      if (total <= maxTotalPromptBytes) return;
      const oldest = oldestStmt.get();
      if (!oldest) return;
      deleteStmt.run(oldest.cache_key);
    }
  }

  return {
    get(cacheKey) {
      const row = getStmt.get(cacheKey);
      if (!row) return undefined;
      return { agentId: row.agent_id, mcpToken: row.mcp_token, fullPrompt: row.full_prompt };
    },
    put({ cacheKey, agentId, mcpToken }) {
      putStmt.run(cacheKey, agentId, mcpToken, "", Date.now());
    },
    updatePrompt(cacheKey, fullPrompt) {
      if (Buffer.byteLength(fullPrompt) > MAX_ROW_PROMPT_BYTES) return;
      updatePromptStmt.run(fullPrompt, Date.now(), cacheKey);
      evictOverBudget();
    },
    delete(cacheKey) {
      deleteStmt.run(cacheKey);
    },
    close() {
      try {
        db.close();
      } catch {}
    }
  };
}
