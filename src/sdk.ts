import type { OpenAiToolSpec } from "./openai.js";
import { toolCallRetryHint, toOpenAiToolCalls } from "./openai.js";
import type { CursorTextEvent, CursorToolCall } from "./types.js";

const TOOL_RETRY_ATTEMPTS = 3;

export interface SdkBridgeSettings {
  url: string;
  token: string;
}

export interface SdkRunInput {
  apiKey: string;
  model: string;
  prompt: string;
  incrementalPrompt?: string;
  sessionKey: string;
  runId: string;
  workingDirectory?: string;
  tools: OpenAiToolSpec[];
  requiresLocalTool: boolean;
}

export interface SdkRunOutput {
  text: string;
  toolCalls: CursorToolCall[];
  agentID: string;
  runID: string;
}

export async function* runSdkStream(
  settings: SdkBridgeSettings,
  input: SdkRunInput
): AsyncGenerator<CursorTextEvent> {
  const shouldRetry = input.requiresLocalTool || input.tools.length > 0;
  if (!shouldRetry) {
    yield* runSdkBridgeOnce(settings, input);
    return;
  }

  let attemptInput = input;
  let lastEvents: CursorTextEvent[] = [];
  for (let attempt = 1; attempt <= TOOL_RETRY_ATTEMPTS; attempt += 1) {
    const events: CursorTextEvent[] = [];
    let sawToolCall = false;
    let rejectedToolCall: CursorToolCall | undefined;
    let rejectedReason: string | undefined;
    for await (const event of runSdkBridgeOnce(settings, attemptInput)) {
      events.push(event);
      if (event.type === "tool_call") sawToolCall = true;
      if (event.type === "rejected_tool_call") {
        rejectedToolCall = event.toolCall;
        rejectedReason = event.reason;
      }
    }
    if (sawToolCall) {
      for (const event of events) yield event;
      return;
    }
    lastEvents = events;
    if ((!rejectedToolCall && !input.requiresLocalTool) || attempt >= TOOL_RETRY_ATTEMPTS) break;
    attemptInput = {
      ...input,
      runId: `run-${crypto.randomUUID()}`,
      prompt: rejectedToolCall
        ? retryPromptAfterUnsupportedTool(input.prompt, rejectedToolCall, rejectedReason, attempt + 1)
        : retryPromptAfterMissingTool(input.prompt, attempt + 1)
    };
  }
  for (const event of lastEvents) yield event;
}

export async function collectSdkOutput(stream: AsyncIterable<CursorTextEvent>): Promise<SdkRunOutput> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  let agentID = "";
  let runID = "";
  for await (const event of stream) {
    if (event.type === "text") text += event.text;
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
    if (event.type === "done") {
      text = event.finalText || text;
      if (event.toolCalls.length && !toolCalls.length) toolCalls.push(...event.toolCalls);
    }
  }
  return { text, toolCalls, agentID, runID };
}

async function* runSdkBridgeOnce(
  settings: SdkBridgeSettings,
  input: SdkRunInput
): AsyncGenerator<CursorTextEvent> {
  const response = await fetch(settings.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.token}`
    },
    body: JSON.stringify({
      apiKey: input.apiKey,
      requestId: input.runId,
      model: input.model,
      prompt: input.prompt,
      incrementalPrompt: input.incrementalPrompt ?? input.prompt,
      promptAlreadyPrepared: true,
      sessionKey: input.sessionKey,
      workingDirectory: input.workingDirectory ?? "",
      streamEvents: true,
      tools: input.tools
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
    const message = payload.error?.message || `Cursor SDK bridge failed with status ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status === 401 ? 401 : response.status;
    throw error;
  }

  let text = "";
  const toolCalls: CursorToolCall[] = [];
  for await (const event of parseNdjson(response.body)) {
    if (event.type === "error") {
      const message = typeof event.error === "object" && event.error && "message" in event.error
        ? String((event.error as { message?: unknown }).message || "Cursor SDK bridge stream failed.")
        : "Cursor SDK bridge stream failed.";
      throw new Error(message);
    }
    if (event.type === "text" && typeof event.text === "string" && event.text) {
      text += event.text;
      yield { type: "text", text: event.text };
    }
    if (event.type === "tool_call") {
      const toolCall = asToolCall(event.toolCall);
      if (!toolCall) continue;
      const mapped = toOpenAiToolCalls({
        toolCalls: [toolCall],
        tools: input.tools,
        responseId: "probe"
      });
      if (input.tools.length && mapped.length === 0) {
        yield {
          type: "rejected_tool_call",
          toolCall,
          reason: toolCallRetryHint({ toolCall, tools: input.tools })
        };
        yield { type: "done", finalText: text, toolCalls };
        return;
      }
      toolCalls.push(toolCall);
      yield { type: "tool_call", toolCall };
      yield { type: "done", finalText: text, toolCalls };
      return;
    }
    if (event.type === "done" && event.output && typeof event.output === "object") {
      const output = event.output as SdkRunOutput;
      const outputText = typeof output.text === "string" ? output.text : text;
      const outputToolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : toolCalls;
      if (outputText && outputText.length > text.length) {
        yield { type: "text", text: outputText.slice(text.length) };
      } else if (!text && outputText) {
        yield { type: "text", text: outputText };
      }
      yield { type: "done", finalText: outputText, toolCalls: outputToolCalls };
      return;
    }
  }
  yield { type: "done", finalText: text, toolCalls };
}

async function* parseNdjson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
        newline = buffer.indexOf("\n");
      }
    }
    const trailing = buffer.trim();
    if (trailing) yield JSON.parse(trailing) as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

function retryPromptAfterMissingTool(prompt: string, attempt: number): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${TOOL_RETRY_ATTEMPTS}):`,
    "Your previous SDK response did not emit a local tool call, but the latest user request requires local execution.",
    "The next response is invalid unless it contains a tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call now using the allowed client tool inventory above, then wait for the local tool result."
  ].join("\n");
}

function retryPromptAfterUnsupportedTool(prompt: string, toolCall: CursorToolCall, reason: string | undefined, attempt: number): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${TOOL_RETRY_ATTEMPTS}):`,
    `Your previous SDK response requested ${toolCall.name}, but that tool could not be mapped to the allowed client tool inventory above.`,
    ...(reason ? [`Mapping failure detail: ${reason}`] : []),
    "The next response is invalid unless it contains a mappable tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call that maps to an allowed client tool."
  ].join("\n");
}

function asToolCall(value: unknown): CursorToolCall | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  return {
    name: value.name,
    arguments: isRecord(value.arguments) ? value.arguments : {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
