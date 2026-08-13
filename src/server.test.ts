import { describe, expect, it } from "vitest";
import { createContext, handleRequest, _resetResponseStateForTests } from "./server.js";
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
});
