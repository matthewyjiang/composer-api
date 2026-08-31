import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openAgentStore } from "./bridge-agent-store.mjs";

const dirs = [];

function tempStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-store-test-"));
  dirs.push(dir);
  return path.join(dir, "store.sqlite3");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bridge agent store", () => {
  it("persists agent rows across reopen", async () => {
    const file = tempStorePath();
    const store = await openAgentStore(file);
    store.put({ cacheKey: "cache-a", agentId: "agent-1", mcpToken: "token-1" });
    store.updatePrompt("cache-a", "full transcript so far");
    store.close();

    const reopened = await openAgentStore(file);
    expect(reopened.get("cache-a")).toEqual({
      agentId: "agent-1",
      mcpToken: "token-1",
      fullPrompt: "full transcript so far"
    });
    reopened.close();
  });

  it("keeps the stored prompt when put() refreshes agent identity", async () => {
    const store = await openAgentStore(tempStorePath());
    store.put({ cacheKey: "cache-a", agentId: "agent-1", mcpToken: "token-1" });
    store.updatePrompt("cache-a", "prompt v1");
    store.put({ cacheKey: "cache-a", agentId: "agent-2", mcpToken: "token-2" });
    expect(store.get("cache-a")).toEqual({ agentId: "agent-2", mcpToken: "token-2", fullPrompt: "" });
    store.close();
  });

  it("deletes rows and returns undefined for missing keys", async () => {
    const store = await openAgentStore(tempStorePath());
    store.put({ cacheKey: "cache-a", agentId: "agent-1", mcpToken: "token-1" });
    store.delete("cache-a");
    expect(store.get("cache-a")).toBeUndefined();
    expect(store.get("never-stored")).toBeUndefined();
    store.close();
  });

  it("evicts the oldest rows when total prompt bytes exceed the budget", async () => {
    const store = await openAgentStore(tempStorePath(), { maxTotalPromptBytes: 100 });
    store.put({ cacheKey: "old", agentId: "agent-1", mcpToken: "t1" });
    store.updatePrompt("old", "x".repeat(80));
    store.put({ cacheKey: "new", agentId: "agent-2", mcpToken: "t2" });
    store.updatePrompt("new", "y".repeat(80));
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")?.agentId).toBe("agent-2");
    store.close();
  });
});
