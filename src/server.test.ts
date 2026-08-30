import { describe, expect, it } from "vitest";
import { createContext, handleRequest, _resetResponseStateForTests } from "./server.js";
import { parseSse } from "./sse.js";
import type { CursorTextEvent } from "./types.js";

function config() {
  return {
    host: "127.0.0.1",
    port: 8787,
    cursorApiKey: "test-cursor-key",
    configPath: "/tmp/api-for-cursor.json"
  };
}

async function* textRun(): AsyncGenerator<CursorTextEvent> {
  yield { type: "text", text: "Hello from Composer." };
  yield { type: "done", finalText: "Hello from Composer.", toolCalls: [] };
}

function context(runSdk: typeof textRun = textRun) {
  return createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
    now: () => new Date("2026-08-12T00:00:00Z"),
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    runSdk: async function* () {
      yield* runSdk();
    }
  });
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(
    new Request(`http://127.0.0.1:8787${path}`, init),
    context()
  );
}

describe("local OpenAI server", () => {
  it("serves health and model list", async () => {
    const health = await request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ object: "api.health", ready: true });

    const models = await request("/v1/models", { headers: { authorization: "Bearer local" } });
    const body = await models.json() as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toContain("composer-2.5");
  });

  it("rejects requests when no Cursor key is configured", async () => {
    const ctx = createContext(
      { ...config(), cursorApiKey: "" },
      { url: "http://127.0.0.1:8792/sdk", token: "bridge" }
    );
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/models", { headers: { authorization: "Bearer local" } }),
      ctx
    );
    expect(response.status).toBe(401);
  });

  it("returns a chat completion from the SDK stream", async () => {
    const response = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Hello" }]
      })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("Hello from Composer.");
  });

  it("returns a responses object and stores it for GET", async () => {
    _resetResponseStateForTests();
    const created = await request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5",
        input: "Hello"
      })
    });
    expect(created.status).toBe(200);
    const body = await created.json() as { id: string; output_text?: string };
    const fetched = await request(`/v1/responses/${body.id}`, {
      headers: { authorization: "Bearer local" }
    });
    expect(fetched.status).toBe(200);
  });

  it("estimates input tokens without calling the SDK", async () => {
    const response = await request("/v1/responses/input_tokens", {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5",
        input: "Hello from a fairly short prompt."
      })
    });
    const body = await response.json() as { object: string; input_tokens: number };
    expect(body.object).toBe("response.input_tokens");
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it("keeps streamed function_call item ids aligned with the completed output when text precedes tools", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      yield { type: "text", text: "I'll look at the repo's docs." };
      yield { type: "tool_call", toolCall: { name: "read", arguments: { path: "AGENTS.md" } } };
      yield {
        type: "done",
        finalText: "I'll look at the repo's docs.",
        toolCalls: [{ name: "read", arguments: { path: "AGENTS.md" } }]
      };
    }
    const ctx = context(run);
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "hi what is this repo?",
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
              }
            }
          ]
        })
      }),
      ctx
    );
    expect(response.status).toBe(200);

    const streamedIds: string[] = [];
    const streamedCallIds: string[] = [];
    let completedIds: string[] = [];
    let completedCallIds: string[] = [];
    for await (const event of parseSse(response.body)) {
      if (!event.data || event.data === "[DONE]") continue;
      const payload = JSON.parse(event.data) as {
        type?: string;
        item?: { type?: string; id?: string; call_id?: string };
        response?: { output?: Array<{ type?: string; id?: string; call_id?: string }> };
      };
      if (payload.type === "response.output_item.added" && payload.item?.type === "function_call") {
        if (payload.item.id) streamedIds.push(payload.item.id);
        if (payload.item.call_id) streamedCallIds.push(payload.item.call_id);
      }
      if (payload.type === "response.completed") {
        const calls = (payload.response?.output ?? []).filter((item) => item.type === "function_call");
        completedIds = calls.map((item) => item.id).filter((id): id is string => Boolean(id));
        completedCallIds = calls.map((item) => item.call_id).filter((id): id is string => Boolean(id));
      }
    }

    expect(streamedCallIds).toHaveLength(1);
    expect(completedCallIds).toEqual(streamedCallIds);
    expect(new Set(completedCallIds).size).toBe(completedCallIds.length);
    expect(completedIds).toEqual(streamedIds);
  });

  it("emits response.failed when the SDK stream throws", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      throw new Error("Request body too large");
    }
    const ctx = context(run);
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "hello"
        })
      }),
      ctx
    );
    expect(response.status).toBe(200);

    const types: string[] = [];
    let failedMessage = "";
    for await (const event of parseSse(response.body)) {
      if (!event.data || event.data === "[DONE]") continue;
      const payload = JSON.parse(event.data) as {
        type?: string;
        error?: { message?: string };
        response?: { error?: { message?: string } };
      };
      if (payload.type) types.push(payload.type);
      if (payload.type === "response.failed") {
        failedMessage = payload.response?.error?.message || "";
      }
    }
    expect(types).toContain("response.created");
    expect(types).toContain("response.in_progress");
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
    expect(failedMessage).toBe("Request body too large");
  });
});
