import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  prepareChatRequest,
  prepareOpencodeSdkChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseFailedEvents,
  responseInputItemsObject,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  incrementalContinuationPrompt,
  type OpenAiToolSpec,
  type PreparedRequest,
  type ToolCallContext
} from "./openai.js";
import { errorResponse, HttpError, json, notFound, openAiError, optionsResponse, parseJsonBody, sseResponse, unauthorized } from "./http.js";
import { encodeSse } from "./sse.js";
import { baseUrl, DISPLAY_NAME, resolveRequestApiKey, type AppConfig } from "./config.js";
import { COMPOSER_MODELS, localModelList, modelById, modelObject, resolveCursorModel } from "./models.js";
import { collectSdkOutput, runSdkStream, type SdkBridgeSettings } from "./sdk.js";
import type { CursorTextEvent } from "./types.js";
import { createHash } from "node:crypto";

// 512 stored responses is a few hours of Rho tool loops at one row per turn.
// LRU already evicts; this is the tripwire, not a guess at peak RAM.
const RESPONSE_STATE_LIMIT = 512;
// 256 KiB covers a long tool-loop item list (~64k tokens of JSON). A 32 MiB
// prompt must not be copied into all 512 slots; oversized states skip prefix
// correlation and still match on previous_response_id / session affinity.
const MAX_STORED_TRANSCRIPT_BYTES = 256 * 1024;
const COMPACTION_INSTRUCTIONS = [
  "You are compacting a long-running local Responses API conversation.",
  "Return a concise continuation summary that preserves user goals, decisions, constraints, important file paths, pending tasks, tool results, and any unresolved errors.",
  "Do not add new actions or answer the original request; only summarize the conversation state for a future model turn."
].join("\n");

interface StoredResponseState {
  ownerKey: string;
  id: string;
  response?: Record<string, unknown>;
  inputItems: unknown[];
  outputItems: unknown[];
  inputFingerprints: string[];
  fullFingerprints: string[];
  functionCallFingerprints: string[];
  sdkSessionKey?: string;
  updatedAt: number;
}

interface SessionPrefixMatch {
  sessionKey: string;
  newInputItems: unknown[];
}

export interface ServerContext {
  config: AppConfig;
  bridge: SdkBridgeSettings;
  now: () => Date;
  randomUUID: () => string;
  runSdk: typeof runSdkStream;
}

type ApiKind = "chat" | "responses";
type Surface = "standard" | "opencode" | "opencodev2";

interface OpenAiRoute {
  kind: "chat" | "responses" | "models" | "model" | "completions" | "response" | "responseInputItems" | "responseCancel" | "responseInputTokens" | "responseCompact";
  surface: Surface;
  responseId?: string;
  modelId?: string;
}

export function createContext(config: AppConfig, bridge: SdkBridgeSettings, overrides: Partial<ServerContext> = {}): ServerContext {
  return {
    config,
    bridge,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    runSdk: runSdkStream,
    ...overrides
  };
}

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse();
  try {
    return await routeRequest(request, ctx);
  } catch (error) {
    if (error instanceof Error && "status" in error && (error as { status?: number }).status === 401) {
      return unauthorized(error.message);
    }
    return errorResponse(error);
  }
}

async function routeRequest(request: Request, ctx: ServerContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (isRead(method) && (path === "/" || path === "/v1")) {
    return json(serviceObject(ctx));
  }
  if (isRead(method) && path === "/health") {
    return json(healthObject(ctx));
  }

  const route = matchOpenAiRoute(path);
  if (!route) return notFound();

  if (route.kind === "models") {
    if (!isRead(method)) return notFound();
    requireApiKey(request, ctx);
    return json(localModelList());
  }
  if (route.kind === "model") {
    if (!isRead(method)) return notFound();
    requireApiKey(request, ctx);
    const model = modelById(route.modelId || "");
    if (!model) return notFound();
    return json(modelObject(model));
  }
  if (route.kind === "response" || route.kind === "responseInputItems" || route.kind === "responseCancel") {
    requireApiKey(request, ctx);
    return handleResponseStateRoute(request, ctx, route);
  }
  if (route.kind === "responseInputTokens") {
    if (method !== "POST") return notFound();
    requireApiKey(request, ctx);
    const body = await parseJsonBody(request);
    const prepared = prepareResponsesRequest(body, resolveCursorModel((body as { model?: unknown }).model));
    return json({
      object: "response.input_tokens",
      input_tokens: Math.max(1, Math.ceil(prepared.promptChars / 4))
    });
  }
  if (route.kind === "responseCompact") {
    if (method !== "POST") return notFound();
    const apiKey = requireApiKey(request, ctx);
    const body = await parseJsonBody<Record<string, unknown>>(request);
    const prepared = prepareCompactionRequest(body);
    const output = await completePrepared(prepared, request, ctx, apiKey, sessionAffinity(request) || `compact-${idSuffix(ctx)}`);
    const id = `resp_${idSuffix(ctx)}`;
    const created = Math.floor(ctx.now().getTime() / 1000);
    const summary = output.text.trim() || "[empty conversation summary]";
    return json({
      id,
      object: "response.compaction",
      created_at: created,
      output: [
        {
          id: `cmp_${id.slice(5)}`,
          type: "compaction",
          encrypted_content: summary
        }
      ],
      usage: {
        input_tokens: Math.max(1, Math.ceil(prepared.promptChars / 4)),
        output_tokens: Math.max(1, Math.ceil(output.text.length / 4))
      }
    });
  }
  if (route.kind === "completions") {
    if (method !== "POST") return notFound();
    const apiKey = requireApiKey(request, ctx);
    const body = await parseJsonBody<Record<string, unknown>>(request);
    const prepared = prepareCompletionRequest(body);
    return handlePrepared(request, ctx, apiKey, "chat", prepared, `cmpl_${idSuffix(ctx)}`);
  }
  if (route.kind !== "chat" && route.kind !== "responses") return notFound();
  if (method !== "POST") return notFound();

  const apiKey = requireApiKey(request, ctx);
  const body = await parseJsonBody(request);
  const requestedModel = typeof (body as { model?: unknown }).model === "string" ? (body as { model: string }).model : "composer-2.5";
  const cursorModel = resolveCursorModel(requestedModel);
  const previousResponseId = route.kind === "responses" ? previousResponseIdFromBody(body) : undefined;
  const ownerKey = responseOwnerKey(apiKey);
  const previousState = previousResponseId ? getResponseState(ownerKey, previousResponseId) : undefined;
  if (previousResponseId && !previousState) throw new HttpError("Response not found", 404, "not_found");

  const prepared =
    route.kind === "chat"
      ? route.surface === "opencodev2"
        ? prepareOpencodeSdkChatRequest(body, cursorModel)
        : prepareChatRequest(body, cursorModel, { forceAgentMode: route.surface === "opencode" })
      : prepareResponsesRequest(body, cursorModel, {
          previousOutput: previousState?.outputItems,
          previousInputItems: previousState?.inputItems
        });
  const id = `${route.kind === "chat" ? "chatcmpl" : "resp"}_${idSuffix(ctx)}`;
  return handlePrepared(request, ctx, apiKey, route.kind, prepared, id, {
    ownerKey: route.kind === "responses" ? ownerKey : undefined,
    previousState
  });
}

async function handlePrepared(
  request: Request,
  ctx: ServerContext,
  apiKey: string,
  kind: ApiKind,
  prepared: PreparedRequest,
  id: string,
  state?: { ownerKey?: string; previousState?: StoredResponseState }
): Promise<Response> {
  const created = Math.floor(ctx.now().getTime() / 1000);
  const affinity = sessionAffinity(request);
  const prefixMatch =
    kind === "responses" && state?.ownerKey && !state.previousState?.sdkSessionKey && !affinity
      ? matchSessionByTranscriptPrefix(state.ownerKey, prepared)
      : undefined;
  const sdkSessionKey =
    state?.previousState?.sdkSessionKey
    || affinity
    || prefixMatch?.sessionKey
    || conversationSeed(prepared)
    || id;
  const knownSession = seenSessionKeys.has(sdkSessionKey)
    || Boolean(state?.previousState?.sdkSessionKey)
    || Boolean(prefixMatch);
  rememberSessionKey(sdkSessionKey);
  const ready = attachIncrementalPrompt(prepared, knownSession, prefixMatch);

  if (ready.stream) {
    return streamPrepared(kind, ready, request, ctx, apiKey, id, created, sdkSessionKey, state?.ownerKey);
  }

  const output = await completePrepared(ready, request, ctx, apiKey, sdkSessionKey);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: ready.tools,
    responseId: id,
    context: ready.toolContext
  });
  if (kind === "chat") {
    return json(
      chatCompletionResponse({
        id,
        created,
        model: ready.model,
        text: output.text,
        toolCalls,
        promptChars: ready.promptChars,
        metadata: ready.responseMetadata
      })
    );
  }
  const response = responseObject({
    id,
    created,
    model: ready.model,
    text: output.text,
    toolCalls,
    promptChars: ready.promptChars,
    metadata: ready.responseMetadata
  });
  if (state?.ownerKey) {
    storeResponseState(state.ownerKey, {
      id,
      response,
      inputItems: ready.responseInputItems ?? [],
      outputItems: (response.output as unknown[]) ?? [],
      store: prepared.storeResponse !== false,
      sdkSessionKey,
      now: ctx.now().getTime()
    });
  }
  return json(response);
}

async function completePrepared(
  prepared: PreparedRequest,
  request: Request,
  ctx: ServerContext,
  apiKey: string,
  sessionKey: string
) {
  const stream = ctx.runSdk(ctx.bridge, sdkInput(prepared, apiKey, sessionKey, ctx));
  return collectSdkOutput(stream);
}

function streamPrepared(
  kind: ApiKind,
  prepared: PreparedRequest,
  request: Request,
  ctx: ServerContext,
  apiKey: string,
  id: string,
  created: number,
  sdkSessionKey: string,
  ownerKey?: string
): Response {
  const cursorEvents = ctx.runSdk(ctx.bridge, sdkInput(prepared, apiKey, sdkSessionKey, ctx));
  return streamOpenAiEvents(kind, cursorEvents, {
    id,
    created,
    model: prepared.model,
    promptChars: prepared.promptChars,
    includeUsage: prepared.includeUsage,
    metadata: prepared.responseMetadata,
    tools: prepared.tools,
    context: prepared.toolContext,
    onDone: async (text, _completionChars, toolCalls) => {
      if (kind === "responses" && ownerKey) {
        const completed = responseObject({
          id,
          created,
          model: prepared.model,
          text,
          toolCalls,
          promptChars: prepared.promptChars,
          metadata: prepared.responseMetadata
        });
        storeResponseState(ownerKey, {
          id,
          response: completed,
          inputItems: prepared.responseInputItems ?? [],
          outputItems: (completed.output as unknown[]) ?? [],
          store: prepared.storeResponse !== false,
          sdkSessionKey,
          now: ctx.now().getTime()
        });
      }
    },
    onError: async () => undefined
  });
}

function sdkInput(prepared: PreparedRequest, apiKey: string, sessionKey: string, ctx: ServerContext) {
  const cursorModel = prepared.cursorModel;
  return {
    apiKey,
    // Bridge expects a base/public model id; params carry effort/fast separately.
    model: cursorModel?.sdkId || cursorModel?.id || prepared.model,
    ...(cursorModel?.params?.length ? { modelParams: cursorModel.params } : {}),
    prompt: prepared.prompt.text,
    ...(prepared.incrementalPrompt && prepared.incrementalPrompt !== prepared.prompt.text
      ? { incrementalPrompt: prepared.incrementalPrompt }
      : {}),
    sessionKey,
    runId: `run-${ctx.randomUUID()}`,
    workingDirectory: prepared.toolContext?.workingDirectory,
    tools: prepared.tools,
    requiresLocalTool: prepared.requiresLocalTool,
    ...(prepared.functionCallOutputs?.length ? { toolResults: prepared.functionCallOutputs } : {})
  };
}

function streamOpenAiEvents(
  kind: ApiKind,
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    metadata?: Record<string, unknown>;
    tools: OpenAiToolSpec[];
    context?: ToolCallContext;
    onDone: (text: string, completionChars: number, toolCalls: ReturnType<typeof toOpenAiToolCalls>) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  }
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    try {
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
            }
            await writer.write(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } }));
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) await writer.write(chunk);
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          // Bridge tool turns send empty finalText. Keep streamed prose so
          // completed output_index matches the function_call already emitted.
          if (event.finalText) text = event.finalText;
        }
      }

      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(text, streamedToolCalls);
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writer.write(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars
            })
          );
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0
        })) await writer.write(event);
      }
      await input.onDone(text, completionCharsFromOutput(text, streamedToolCalls), streamedToolCalls);
    } catch (error) {
      await input.onError(error).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Stream failed";
      console.error(`OpenAI SSE stream failed: ${message}`);
      try {
        if (kind === "chat") {
          await writer.write(encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error"));
        } else {
          for (const event of responseFailedEvents({
            id: input.id,
            created: input.created,
            model: input.model,
            message,
            metadata: input.metadata
          })) {
            await writer.write(event);
          }
        }
      } catch {
        // Client already dropped the SSE connection.
      }
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  void pump();
  return sseResponse(readable);
}

function prepareCompletionRequest(body: unknown): PreparedRequest {
  const record = expectRecord(body);
  const prompt = record.prompt;
  const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? "");
  return prepareChatRequest(
    {
      model: record.model,
      messages: [{ role: "user", content: text }],
      stream: record.stream === true,
      max_tokens: record.max_tokens,
      temperature: record.temperature,
      top_p: record.top_p
    },
    resolveCursorModel(record.model)
  );
}

function prepareCompactionRequest(body: unknown): PreparedRequest {
  const record = expectRecord(body);
  const extra = typeof record.instructions === "string" ? record.instructions.trim() : "";
  return prepareResponsesRequest(
    {
      ...record,
      instructions: extra ? `${COMPACTION_INSTRUCTIONS}\n\nCOMPACTION INSTRUCTIONS:\n${extra}` : COMPACTION_INSTRUCTIONS,
      stream: false,
      tools: []
    },
    resolveCursorModel(record.model)
  );
}

function handleResponseStateRoute(request: Request, ctx: ServerContext, route: OpenAiRoute): Response {
  if (!route.responseId) return notFound();
  const apiKey = requireApiKey(request, ctx);
  const state = getResponseState(responseOwnerKey(apiKey), route.responseId);
  if (!state) throw new HttpError("Response not found", 404, "not_found");

  if (route.kind === "response") {
    if (isRead(request.method)) {
      if (!state.response) throw new HttpError("Response not found", 404, "not_found");
      return json(state.response);
    }
    if (request.method === "DELETE") {
      responseState.delete(responseStateKey(state.ownerKey, route.responseId));
      return json({ id: route.responseId, object: "response", deleted: true });
    }
    return notFound();
  }
  if (route.kind === "responseInputItems") {
    if (!isRead(request.method)) return notFound();
    if (!state.response) throw new HttpError("Response not found", 404, "not_found");
    return json(responseInputItemsObject(state.inputItems));
  }
  if (route.kind === "responseCancel") {
    if (request.method !== "POST") return notFound();
    throw new HttpError("Only background responses can be cancelled. API for Cursor runs responses synchronously.", 400, "invalid_request_error");
  }
  return notFound();
}

function matchOpenAiRoute(pathname: string): OpenAiRoute | null {
  const opencodePath = pathname.startsWith("/opencode/v1/") ? pathname.slice("/opencode/v1".length) : "";
  if (opencodePath) return matchV1Path(opencodePath, "opencode");
  const opencodeV2Path = pathname.startsWith("/opencodev2/v1/") ? pathname.slice("/opencodev2/v1".length) : "";
  if (opencodeV2Path) return matchV1Path(opencodeV2Path, "opencodev2");
  if (!pathname.startsWith("/v1/")) return null;
  return matchV1Path(pathname.slice(3), "standard");
}

function matchV1Path(path: string, surface: Surface): OpenAiRoute | null {
  if (path === "/chat/completions") return { kind: "chat", surface };
  if (path === "/responses") return { kind: "responses", surface };
  if (path === "/responses/input_tokens") return { kind: "responseInputTokens", surface };
  if (path === "/responses/compact") return { kind: "responseCompact", surface };
  if (path === "/completions") return { kind: "completions", surface };
  if (path === "/models") return { kind: "models", surface };
  const modelMatch = /^\/models\/([^/]+)\/?$/.exec(path);
  if (modelMatch) return { kind: "model", surface, modelId: decodeURIComponent(modelMatch[1]) };
  const inputItems = /^\/responses\/([^/]+)\/input_items\/?$/.exec(path);
  if (inputItems) return { kind: "responseInputItems", surface, responseId: inputItems[1] };
  const cancel = /^\/responses\/([^/]+)\/cancel\/?$/.exec(path);
  if (cancel) return { kind: "responseCancel", surface, responseId: cancel[1] };
  const response = /^\/responses\/([^/]+)\/?$/.exec(path);
  if (response) return { kind: "response", surface, responseId: response[1] };
  return null;
}

function requireApiKey(request: Request, ctx: ServerContext): string {
  const apiKey = resolveRequestApiKey(request.headers.get("authorization") || undefined, ctx.config.cursorApiKey);
  if (!apiKey) throw new HttpError("Enter a Cursor API key to start the local API.", 401, "unauthorized");
  return apiKey;
}

function serviceObject(ctx: ServerContext): Record<string, unknown> {
  const health = healthObject(ctx);
  return {
    object: "api.service",
    service: DISPLAY_NAME,
    baseUrl: baseUrl(ctx.config),
    status: health.status,
    ready: health.ready,
    models: COMPOSER_MODELS.map((model) => model.id),
    endpoints: {
      models: "/v1/models",
      chat_completions: "/v1/chat/completions",
      responses: "/v1/responses",
      response_input_tokens: "POST /v1/responses/input_tokens",
      compact_response: "POST /v1/responses/compact",
      delete_response: "DELETE /v1/responses/{response_id}",
      cancel_response: "POST /v1/responses/{response_id}/cancel",
      completions: "/v1/completions",
      health: "/health"
    },
    features: {
      chat_completions: true,
      responses: true,
      stateful_responses: true,
      response_input_tokens: true,
      response_compaction: true,
      response_deletion: true,
      response_cancellation: false,
      streaming: true,
      tool_calls: true
    }
  };
}

function healthObject(ctx: ServerContext): Record<string, unknown> {
  const ready = Boolean(ctx.config.cursorApiKey);
  return {
    object: "api.health",
    status: ready ? "ok" : "needs_api_key",
    ready,
    sdkBridgeConfigured: true
  };
}

function sessionAffinity(request: Request): string | undefined {
  return (
    request.headers.get("x-session-affinity") ||
    request.headers.get("x-opencode-session-id") ||
    request.headers.get("x-opencode-session")
  )?.trim() || undefined;
}

function matchSessionByTranscriptPrefix(ownerKey: string | undefined, prepared: PreparedRequest): SessionPrefixMatch | undefined {
  if (!ownerKey) return undefined;
  const currentItems = prepared.responseInputItems ?? [];
  const current = fingerprintsForItems(currentItems);
  if (!current.length) return undefined;
  let best: { sessionKey: string; updatedAt: number; newInputItems: unknown[] } | undefined;
  for (const stored of responseState.values()) {
    if (stored.ownerKey !== ownerKey || !stored.sdkSessionKey) continue;
    const inputPrefix = stored.inputFingerprints;
    const fullPrefix = stored.fullFingerprints;
    const outputCalls = stored.functionCallFingerprints;
    const exactPrefix = fullPrefix.length > 0 && fingerprintPrefix(fullPrefix, current);
    // Rho resends input items plus function_call_output, not assistant message
    // output items. Require the stored input prefix and every stored function_call.
    const inputAndCalls = inputPrefix.length > 0
      && fingerprintPrefix(inputPrefix, current)
      && outputCalls.every((call) => current.includes(call));
    if (!exactPrefix && !inputAndCalls) continue;
    const newInputItems = exactPrefix
      ? currentItems.slice(fullPrefix.length)
      : leftoverAfterInputAndCalls(currentItems, inputPrefix.length, outputCalls);
    if (!best || stored.updatedAt > best.updatedAt) {
      best = { sessionKey: stored.sdkSessionKey, updatedAt: stored.updatedAt, newInputItems };
    }
  }
  return best ? { sessionKey: best.sessionKey, newInputItems: best.newInputItems } : undefined;
}

function leftoverAfterInputAndCalls(currentItems: unknown[], inputPrefixLength: number, outputCallFingerprints: string[]): unknown[] {
  return currentItems.slice(inputPrefixLength).filter((item) => {
    const fingerprint = JSON.stringify(canonicalResponseItem(item));
    return !outputCallFingerprints.includes(fingerprint);
  });
}

function fingerprintPrefix(prefix: string[], current: string[]): boolean {
  if (current.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== current[index]) return false;
  }
  return true;
}

function fingerprintsForItems(items: unknown[]): string[] {
  return canonicalResponseItems(items).map((item) => JSON.stringify(item));
}

function attachIncrementalPrompt(
  prepared: PreparedRequest,
  knownSession: boolean,
  prefixMatch?: SessionPrefixMatch
): PreparedRequest {
  if (prepared.incrementalPrompt || !knownSession) return prepared;
  const continuationInput = prefixMatch?.newInputItems?.length
    ? prefixMatch.newInputItems
    : prepared.responseInputItems;
  if (!continuationInput?.length) return prepared;
  const incremental = incrementalContinuationPrompt(continuationInput, prepared.tools);
  if (!incremental || incremental === prepared.prompt.text) return prepared;
  return { ...prepared, incrementalPrompt: incremental };
}

function canonicalResponseItems(items: unknown[]): unknown[] {
  return items.map(canonicalResponseItem);
}

function canonicalResponseItem(item: unknown): unknown {
  if (typeof item === "string") return { type: "input_text", text: item };
  if (!isRecord(item)) return item;
  const type = typeof item.type === "string" ? item.type : typeof item.role === "string" ? "message" : "unknown";
  if (type === "message" || typeof item.role === "string") {
    return {
      type: "message",
      role: typeof item.role === "string" ? item.role : "user",
      text: contentTextForPrefix(item.content)
    };
  }
  if (type === "function_call") {
    return {
      type: "function_call",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
    };
  }
  if (type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
    };
  }
  return { type, value: item };
}

function contentTextForPrefix(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (isRecord(part) && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function boundedTranscriptItems(items: unknown[]): unknown[] {
  const json = JSON.stringify(items);
  if (Buffer.byteLength(json) <= MAX_STORED_TRANSCRIPT_BYTES) return items;
  return [];
}

const AGENT_MODE_SWITCH_USER = "Please switch to agent mode.";
const SEEN_SESSION_LIMIT = 2048;
const seenSessionKeys = new Set<string>();

function rememberSessionKey(sessionKey: string) {
  if (seenSessionKeys.has(sessionKey)) {
    seenSessionKeys.delete(sessionKey);
    seenSessionKeys.add(sessionKey);
    return;
  }
  seenSessionKeys.add(sessionKey);
  if (seenSessionKeys.size <= SEEN_SESSION_LIMIT) return;
  const oldest = seenSessionKeys.values().next().value;
  if (oldest) seenSessionKeys.delete(oldest);
}

function conversationSeed(prepared: PreparedRequest): string | undefined {
  const text = prepared.prompt.text;
  let user: string | undefined;
  for (const match of text.matchAll(/\nUSER: (.+)/g)) {
    const line = match[1]?.trim();
    if (line && line !== AGENT_MODE_SWITCH_USER) {
      user = line;
      break;
    }
  }
  const inputIdx = text.indexOf("\nINPUT:\n");
  const inputFirst = inputIdx >= 0 ? text.slice(inputIdx + "\nINPUT:\n".length).split("\n")[0]?.trim() : undefined;
  const seed = user || inputFirst;
  if (!seed) return undefined;
  return `conv_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function previousResponseIdFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body.previous_response_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function responseOwnerKey(apiKey: string): string {
  return `direct:${apiKey.slice(0, 24)}`;
}

const responseState = new Map<string, StoredResponseState>();

function getResponseState(ownerKey: string, responseId: string): StoredResponseState | undefined {
  return responseState.get(responseStateKey(ownerKey, responseId));
}

function storeResponseState(
  ownerKey: string,
  input: {
    id: string;
    response: Record<string, unknown>;
    inputItems: unknown[];
    outputItems: unknown[];
    store: boolean;
    sdkSessionKey?: string;
    now: number;
  }
) {
  const storedInputItems = input.store ? boundedTranscriptItems(input.inputItems) : [];
  const storedOutputItems = boundedTranscriptItems(input.outputItems);
  const canonicalOutput = canonicalResponseItems(storedOutputItems);
  responseState.set(responseStateKey(ownerKey, input.id), {
    ownerKey,
    id: input.id,
    response: input.store ? input.response : undefined,
    inputItems: storedInputItems,
    outputItems: storedOutputItems,
    inputFingerprints: fingerprintsForItems(storedInputItems),
    fullFingerprints: fingerprintsForItems([...storedInputItems, ...storedOutputItems]),
    functionCallFingerprints: canonicalOutput
      .filter((item) => isRecord(item) && item.type === "function_call")
      .map((item) => JSON.stringify(item)),
    sdkSessionKey: input.sdkSessionKey,
    updatedAt: input.now
  });
  if (responseState.size <= RESPONSE_STATE_LIMIT) return;
  const extra = [...responseState.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  for (const [key] of extra.slice(0, extra.length - RESPONSE_STATE_LIMIT)) {
    responseState.delete(key);
  }
}

function responseStateKey(ownerKey: string, responseId: string): string {
  return `${ownerKey}:${responseId}`;
}

function idSuffix(ctx: ServerContext): string {
  return ctx.randomUUID().replaceAll("-", "");
}

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError("body must be an object", 400, "invalid_request_error");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function _resetResponseStateForTests(): void {
  responseState.clear();
  seenSessionKeys.clear();
}
