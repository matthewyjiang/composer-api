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
    const body = await models.json() as { data: Array<{ id: string; context_length?: number }> };
    expect(body.data.map((item) => item.id)).toContain("composer-2.5");
    expect(body.data.find((item) => item.id === "composer-2.5")?.context_length).toBe(200_000);
    expect(body.data.find((item) => item.id === "grok-4.6")?.context_length).toBe(256_000);
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

  it("uses Cursor SDK token usage when the stream reports it", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      yield { type: "text", text: "ok" };
      yield {
        type: "done",
        finalText: "ok",
        toolCalls: [],
        usage: {
          inputTokens: 200,
          outputTokens: 10,
          cacheReadTokens: 800,
          cacheWriteTokens: 0,
          totalTokens: 1010
        }
      };
    }
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Hello" }]
        })
      }),
      context(run)
    );
    const body = await response.json() as {
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details: { cached_tokens: number; uncached_tokens: number };
        cost: { uncached_tokens: number; cached_tokens: number };
      };
    };
    expect(body.usage).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 800, uncached_tokens: 200 },
      cost: { uncached_tokens: 200, cached_tokens: 800, uncached_usd: 0.0001 }
    });
  });

  it("reports uncached tokens on Responses usage when Cursor reports cache reads", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      yield { type: "text", text: "ok" };
      yield {
        type: "done",
        finalText: "ok",
        toolCalls: [],
        usage: {
          inputTokens: 200,
          outputTokens: 10,
          cacheReadTokens: 800,
          cacheWriteTokens: 0,
          totalTokens: 1010
        }
      };
    }
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          input: "Hello"
        })
      }),
      context(run)
    );
    const body = await response.json() as {
      usage: {
        input_tokens: number;
        input_tokens_details: { cached_tokens: number; uncached_tokens: number };
        cost: { uncached_tokens: number };
      };
    };
    expect(body.usage).toMatchObject({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 800, uncached_tokens: 200 },
      cost: { uncached_tokens: 200, cached_tokens: 800, uncached_usd: 0.0001 }
    });
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

  it("keeps function_call output ids aligned when done.finalText is empty after streamed prose", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      yield { type: "text", text: "I'll read the file." };
      yield { type: "tool_call", toolCall: { name: "read", arguments: { path: "AGENTS.md" } } };
      yield { type: "done", finalText: "", toolCalls: [{ name: "read", arguments: { path: "AGENTS.md" } }] };
    }
    const ctx = context(run);
    const response = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "read the docs",
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
            }
          ]
        })
      }),
      ctx
    );
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
    expect(completedIds).toEqual(streamedIds);
    expect(new Set(completedCallIds).size).toBe(1);
  });

  it("streams multiple function_call items from one SDK turn", async () => {
    async function* run(): AsyncGenerator<CursorTextEvent> {
      yield { type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "foo" } } };
      yield { type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "bar" } } };
      yield {
        type: "done",
        finalText: "",
        toolCalls: [
          { name: "grep", arguments: { pattern: "foo" } },
          { name: "grep", arguments: { pattern: "bar" } }
        ]
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
          input: "search twice",
          tools: [
            {
              type: "function",
              name: "grep",
              parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
          ]
        })
      }),
      ctx
    );
    const callIds: string[] = [];
    for await (const event of parseSse(response.body)) {
      if (!event.data || event.data === "[DONE]") continue;
      const payload = JSON.parse(event.data) as { type?: string; item?: { type?: string; call_id?: string } };
      if (payload.type === "response.output_item.added" && payload.item?.type === "function_call" && payload.item.call_id) {
        callIds.push(payload.item.call_id);
      }
    }
    expect(callIds).toHaveLength(2);
    expect(new Set(callIds).size).toBe(2);
  });

  it("does not key Responses sessions on workingDirectory", async () => {
    _resetResponseStateForTests();
    const keys: string[] = [];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(keys.length + 1),
      runSdk: async function* (_settings, input) {
        keys.push(input.sessionKey);
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });
    for (const text of [
      "First unique conversation AAAA\nWorking directory: /tmp/project",
      "Second unique conversation BBBB\nWorking directory: /tmp/project"
    ]) {
      await handleRequest(
        new Request("http://127.0.0.1:8787/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer local", "content-type": "application/json" },
          body: JSON.stringify({ model: "composer-2.5", input: text })
        }),
        ctx
      );
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("correlates stateless Responses follow-ups by structural item prefix", async () => {
    _resetResponseStateForTests();
    const keys: string[] = [];
    let turn = 0;
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(keys.length + 1),
      runSdk: async function* (_settings, input) {
        keys.push(input.sessionKey);
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", toolCall: { id: "call_prefix_1", name: "read", arguments: { path: "AGENTS.md" } } };
          yield { type: "done", finalText: "", toolCalls: [{ id: "call_prefix_1", name: "read", arguments: { path: "AGENTS.md" } }] };
          return;
        }
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });
    const tools = [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }
    ];
    const first = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          input: [{ type: "message", role: "user", content: "unique prefix transcript zzz" }],
          tools
        })
      }),
      ctx
    );
    const created = await first.json() as { output: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> };
    const functionCall = created.output.find((item) => item.type === "function_call");
    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          input: [
            { type: "message", role: "user", content: "unique prefix transcript zzz" },
            functionCall,
            { type: "function_call_output", call_id: functionCall?.call_id, output: "docs" }
          ],
          tools
        })
      }),
      ctx
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("passes incrementalPrompt when correlating by structural item prefix", async () => {
    _resetResponseStateForTests();
    const calls: Array<{ incrementalPrompt?: string; sessionKey: string }> = [];
    let turn = 0;
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(calls.length + 1),
      runSdk: async function* (_settings, input) {
        calls.push({ incrementalPrompt: input.incrementalPrompt, sessionKey: input.sessionKey });
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", toolCall: { id: "call_prefix_1", name: "read", arguments: { path: "AGENTS.md" } } };
          yield { type: "done", finalText: "", toolCalls: [{ id: "call_prefix_1", name: "read", arguments: { path: "AGENTS.md" } }] };
          return;
        }
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });
    const tools = [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }
    ];
    const first = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          input: [{ type: "message", role: "user", content: "unique prefix incremental zzz" }],
          tools
        })
      }),
      ctx
    );
    const created = await first.json() as { output: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> };
    const functionCall = created.output.find((item) => item.type === "function_call");
    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          input: [
            { type: "message", role: "user", content: "unique prefix incremental zzz" },
            functionCall,
            { type: "function_call_output", call_id: functionCall?.call_id, output: "docs" }
          ],
          tools
        })
      }),
      ctx
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].sessionKey).toBe(calls[1].sessionKey);
    expect(calls[0].incrementalPrompt).toBeUndefined();
    expect(calls[1].incrementalPrompt).toContain("docs");
    expect(calls[1].incrementalPrompt).not.toContain("unique prefix incremental zzz");
  });

  it("reuses a conversation session key across Responses turns without previous_response_id", async () => {
    _resetResponseStateForTests();
    const keys: string[] = [];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(keys.length + 1),
      runSdk: async function* (_settings, input) {
        keys.push(input.sessionKey);
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });

    for (const input of ["Hello from a unique prompt 123", "Hello from a unique prompt 123\nTOOL RESULT: x"]) {
      await handleRequest(
        new Request("http://127.0.0.1:8787/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer local", "content-type": "application/json" },
          body: JSON.stringify({ model: "composer-2.5", input })
        }),
        ctx
      );
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^conv_/);
  });

  it("does not collapse agent-mode chat sessions onto the primer user line", async () => {
    _resetResponseStateForTests();
    const keys: string[] = [];
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      }
    ];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(keys.length + 1),
      runSdk: async function* (_settings, input) {
        keys.push(input.sessionKey);
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });
    for (const content of ["unique agent chat AAAA", "unique agent chat BBBB"]) {
      await handleRequest(
        new Request("http://127.0.0.1:8787/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer local", "content-type": "application/json" },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content }],
            tools
          })
        }),
        ctx
      );
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("passes incrementalPrompt on chat follow-up turns", async () => {
    _resetResponseStateForTests();
    const calls: Array<{ incrementalPrompt?: string; sessionKey: string }> = [];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(calls.length + 1),
      runSdk: async function* (_settings, input) {
        calls.push({ incrementalPrompt: input.incrementalPrompt, sessionKey: input.sessionKey });
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      }
    });
    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "unique chat seed zzz" }]
        })
      }),
      ctx
    );
    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "unique chat seed zzz" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "and now the next turn" }
          ]
        })
      }),
      ctx
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].incrementalPrompt).toBeUndefined();
    expect(calls[0].sessionKey).toBe(calls[1].sessionKey);
    expect(calls[1].incrementalPrompt).toContain("and now the next turn");
    expect(calls[1].incrementalPrompt).not.toContain("unique chat seed zzz");
  });

  it("passes new Responses input as incrementalPrompt on previous_response_id follow-up", async () => {
    _resetResponseStateForTests();
    const calls: Array<{ prompt: string; incrementalPrompt?: string; sessionKey: string }> = [];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      runSdk: async function* (_settings, input) {
        calls.push({
          prompt: input.prompt,
          incrementalPrompt: input.incrementalPrompt,
          sessionKey: input.sessionKey
        });
        yield { type: "text", text: "Hello from Composer." };
        yield { type: "done", finalText: "Hello from Composer.", toolCalls: [] };
      }
    });

    const created = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({ model: "composer-2.5", input: "Hello" })
      }),
      ctx
    );
    const body = await created.json() as { id: string };

    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          previous_response_id: body.id,
          input: [{ type: "function_call_output", call_id: "call_1", output: "README.md" }]
        })
      }),
      ctx
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].incrementalPrompt).toBeUndefined();
    expect(calls[0].prompt).toContain("Hello");
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
    expect(calls[1].incrementalPrompt).toContain("README.md");
    expect(calls[1].incrementalPrompt).not.toContain("Hello");
    expect(calls[1].prompt).toContain("Hello");
    expect(calls[1].prompt).toContain("README.md");
  });

  it("persists reconstructed input so a third Responses turn does not duplicate users", async () => {
    _resetResponseStateForTests();
    const calls: Array<{ prompt: string; incrementalPrompt?: string }> = [];
    const ctx = createContext(config(), { url: "http://127.0.0.1:8792/sdk", token: "bridge" }, {
      now: () => new Date("2026-08-12T00:00:00Z"),
      randomUUID: () => "00000000-0000-4000-8000-00000000000" + String(calls.length + 1),
      runSdk: async function* (_settings, input) {
        calls.push({ prompt: input.prompt, incrementalPrompt: input.incrementalPrompt });
        yield { type: "text", text: `ok ${calls.length}` };
        yield { type: "done", finalText: `ok ${calls.length}`, toolCalls: [] };
      }
    });

    const first = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({ model: "composer-2.5", input: [{ type: "message", role: "user", content: "turn one" }] })
      }),
      ctx
    );
    const firstBody = await first.json() as { id: string };
    const second = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          previous_response_id: firstBody.id,
          input: [
            { type: "message", role: "user", content: "turn one" },
            { type: "message", role: "user", content: "turn two" }
          ]
        })
      }),
      ctx
    );
    const secondBody = await second.json() as { id: string };
    await handleRequest(
      new Request("http://127.0.0.1:8787/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          previous_response_id: secondBody.id,
          input: [
            { type: "message", role: "user", content: "turn one" },
            { type: "message", role: "user", content: "turn two" },
            { type: "message", role: "user", content: "turn three" }
          ]
        })
      }),
      ctx
    );

    const third = calls[2];
    const userLines = third.prompt.split("\n").filter((line) => line.startsWith("USER:"));
    expect(userLines.filter((line) => line.includes("turn one"))).toHaveLength(1);
    expect(userLines.filter((line) => line.includes("turn two"))).toHaveLength(1);
    expect(userLines.filter((line) => line.includes("turn three"))).toHaveLength(1);
    expect(third.incrementalPrompt).toContain("turn three");
    expect(third.incrementalPrompt).not.toContain("turn one");

    const items = await handleRequest(
      new Request(`http://127.0.0.1:8787/v1/responses/${secondBody.id}/input_items`, {
        headers: { authorization: "Bearer local" }
      }),
      ctx
    );
    const listed = await items.json() as { data: Array<{ content?: unknown }> };
    const texts = listed.data.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content));
    expect(texts.filter((text) => text.includes("turn one"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("turn two"))).toHaveLength(1);
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
