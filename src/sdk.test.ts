import { afterEach, describe, expect, it } from "vitest";
import { runSdkStream, type SdkRunInput } from "./sdk.js";

const encoder = new TextEncoder();
const settings = { url: "http://127.0.0.1:8792/sdk", token: "bridge" };
const originalFetch = globalThis.fetch;

function input(overrides: Partial<SdkRunInput> = {}): SdkRunInput {
  return {
    apiKey: "cursor-key",
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    runId: "run-1",
    tools: [{ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    requiresLocalTool: false,
    ...overrides
  };
}

function ndjsonStream(lines: string[], hold?: Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      if (hold) await hold;
      controller.close();
    }
  });
}

describe("runSdkStream", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards tool-bearing text before the bridge run finishes", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () =>
      new Response(ndjsonStream([JSON.stringify({ type: "text", text: "partial" })], hold), { status: 200 });

    const iterator = runSdkStream(settings, input())[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { type: "text", text: "partial" } });
    release();
    await iterator.next();
  });

  it("posts a distinct incrementalPrompt", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(ndjsonStream([JSON.stringify({ type: "done", output: { text: "ok", toolCalls: [] } })]), {
        status: 200
      });
    };

    for await (const _event of runSdkStream(settings, input({ incrementalPrompt: "TOOL RESULT: README.md" }))) {
      // drain
    }
    expect(body?.prompt).toBe("hello");
    expect(body?.incrementalPrompt).toBe("TOOL RESULT: README.md");
  });

  it("forwards multiple tool_call events before done", async () => {
    const events = [];
    globalThis.fetch = async () =>
      new Response(
        ndjsonStream([
          JSON.stringify({ type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "foo" } } }),
          JSON.stringify({ type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "bar" } } }),
          JSON.stringify({
            type: "done",
            output: {
              text: "",
              toolCalls: [
                { name: "grep", arguments: { pattern: "foo" } },
                { name: "grep", arguments: { pattern: "bar" } }
              ]
            }
          })
        ]),
        { status: 200 }
      );

    for await (const event of runSdkStream(
      settings,
      input({ tools: [{ name: "grep", parameters: { type: "object", properties: { pattern: { type: "string" } } } }] })
    )) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "foo" } } },
      { type: "tool_call", toolCall: { name: "grep", arguments: { pattern: "bar" } } }
    ]);
  });

  it("posts function_call_output toolResults to the bridge", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(ndjsonStream([JSON.stringify({ type: "done", output: { text: "ok", toolCalls: [] } })]), {
        status: 200
      });
    };
    for await (const _event of runSdkStream(settings, input({
      toolResults: [{ call_id: "call_1", output: "README.md" }]
    }))) {
      // drain
    }
    expect(body?.toolResults).toEqual([{ call_id: "call_1", output: "README.md" }]);
  });

  it("forwards text immediately when a local tool is required", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () =>
      new Response(ndjsonStream([JSON.stringify({ type: "text", text: "I'll write the file." })], hold), { status: 200 });

    const iterator = runSdkStream(settings, input({ requiresLocalTool: true }))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { type: "text", text: "I'll write the file." } });
    release();
    await iterator.next();
  });

  it("omits incrementalPrompt when it matches the full prompt", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(ndjsonStream([JSON.stringify({ type: "done", output: { text: "ok", toolCalls: [] } })]), {
        status: 200
      });
    };

    const events = [];
    for await (const event of runSdkStream(settings, input())) events.push(event);
    expect(body?.prompt).toBe("hello");
    expect(body?.incrementalPrompt).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "ok" });
  });

  it("does not re-emit a tail when done output text is not an extension of the streamed text", async () => {
    // Regression: multi-turn bridge runs used to report output.text containing
    // earlier turns' prose. Slicing by length alone re-emitted the end of the
    // current turn as a duplicate delta.
    globalThis.fetch = async () =>
      new Response(
        ndjsonStream([
          JSON.stringify({ type: "text", text: "current turn answer" }),
          JSON.stringify({ type: "done", output: { text: "earlier turn prose current turn answer", toolCalls: [] } })
        ]),
        { status: 200 }
      );
    const events = [];
    for await (const event of runSdkStream(settings, input())) events.push(event);
    const textEvents = events.filter((event) => event.type === "text");
    expect(textEvents).toEqual([{ type: "text", text: "current turn answer" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "earlier turn prose current turn answer" });
  });

  it("still emits the unstreamed remainder when done output extends the streamed text", async () => {
    globalThis.fetch = async () =>
      new Response(
        ndjsonStream([
          JSON.stringify({ type: "text", text: "partial " }),
          JSON.stringify({ type: "done", output: { text: "partial answer", toolCalls: [] } })
        ]),
        { status: 200 }
      );
    const events = [];
    for await (const event of runSdkStream(settings, input())) events.push(event);
    const textEvents = events.filter((event) => event.type === "text");
    expect(textEvents).toEqual([
      { type: "text", text: "partial " },
      { type: "text", text: "answer" }
    ]);
  });

  it("forwards Cursor token usage from the done output", async () => {
    const usage = {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      totalTokens: 55
    };
    globalThis.fetch = async () =>
      new Response(ndjsonStream([JSON.stringify({ type: "done", output: { text: "ok", toolCalls: [], usage } })]), {
        status: 200
      });
    const events = [];
    for await (const event of runSdkStream(settings, input())) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "ok", usage });
  });
});
