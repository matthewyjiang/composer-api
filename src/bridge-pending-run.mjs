export function createPendingRunRuntime({
  maxPendingRuns,
  parkedCallTimeoutMs,
  toolFlushGraceMs,
  writeJson,
  normalizeSDKToolCall,
  evictAgent,
  stripFinalMarker,
  sdkRunFailureError,
  isRecord,
  normalizeTokenUsage
}) {
  const pendingRunsBySession = new Map();
  const pendingRunsByToken = new Map();
  const parkedMcpCalls = new Map();
  let parkedCallTimeoutMsOverride;

  function currentParkedCallTimeoutMs() {
    return parkedCallTimeoutMsOverride ?? parkedCallTimeoutMs;
  }

  async function attachOrStart(input, { onRun, onEvent, startFresh }) {
    const existing = pendingRunsBySession.get(input.sessionKey);
    if (existing && !existing.evicted) {
      const results = Array.isArray(input.toolResults) ? input.toolResults : [];
      const matched = results.filter((result) => parkedMcpCalls.has(result.call_id) && parkedMcpCalls.get(result.call_id)?.runToken === existing.runToken);
      if (matched.length && !existing.streamEnded && !existing.streamError) {
        onRun(existing.run);
        return resumePendingRun(existing, matched, onEvent);
      }
      evictPendingRun(existing, "unmatched_or_stale_pending_run");
      if (existing.agentEntry) evictAgent(existing.agentEntry.cacheKey, existing.agentEntry.agent);
    }
    return startFresh(input, onRun, onEvent);
  }

  async function resumePendingRun(pending, results, onEvent) {
    for (const result of results) {
      resolveParkedMcpCall(result.call_id, result.output);
    }
    return attachConsumerAndWait(pending, onEvent);
  }

  function beginPendingRun(input, agentEntry, runToken) {
    while (pendingRunsBySession.size >= maxPendingRuns) {
      const oldest = [...pendingRunsBySession.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      evictPendingRun(oldest, "pending_run_capacity");
    }
    const pending = {
      sessionKey: input.sessionKey,
      runToken,
      cacheKey: agentEntry.cacheKey,
      input,
      agentEntry,
      run: null,
      parkedCallIds: new Set(),
      turnParked: [],
      buffered: [],
      text: "",
      streamEnded: false,
      streamError: null,
      evicted: false,
      createdAt: Date.now(),
      consumer: null,
      mcpToken: agentEntry.mcpToken,
      notifyParked: null,
      consumeLoop: null,
      usage: undefined
    };
    pendingRunsBySession.set(input.sessionKey, pending);
    pendingRunsByToken.set(runToken, pending);
    if (agentEntry.mcpToken) pendingRunsByToken.set(agentEntry.mcpToken, pending);
    return pending;
  }

  function bindRun(pending, run) {
    pending.run = run;
    startStreamConsumer(pending);
  }

  function startStreamConsumer(pending) {
    pending.consumeLoop = (async () => {
      try {
        for await (const event of pending.run.stream()) {
          if (pending.evicted) return;
          handlePendingStreamEvent(pending, event);
        }
        pending.streamEnded = true;
      } catch (error) {
        if (!pending.evicted) pending.streamError = error;
      } finally {
        pending.notifyParked?.();
      }
    })();
  }

  function runUsage(pending, result) {
    return normalizeTokenUsage(pending.run?.usage)
      || normalizeTokenUsage(result?.usage)
      || normalizeTokenUsage(pending.usage);
  }

  function handlePendingStreamEvent(pending, event) {
    if (event.type === "usage") {
      pending.usage = event.usage;
      return;
    }
    if (event.type !== "assistant") return;
    for (const block of event.message?.content ?? []) {
      if (block?.type !== "text" || typeof block.text !== "string" || !block.text) continue;
      const textEvent = { type: "text", text: block.text };
      if (pending.consumer?.emit) {
        pending.text += block.text;
        pending.consumer.emit(textEvent);
      } else {
        pending.buffered.push(textEvent);
      }
    }
  }

  async function attachConsumerAndWait(pending, onEvent) {
    pending.turnParked = [];
    // Each attach serves one client turn. Reset the text accumulator so the
    // final turn's result does not include prose from earlier tool-call turns
    // (which the client already received), otherwise consumers that diff
    // streamed text against result text emit a duplicated tail.
    pending.text = "";
    pending.consumer = { emit: onEvent };
    for (const event of pending.buffered) {
      if (event.type === "text") {
        pending.text += event.text;
        onEvent?.(event);
      } else if (event.type === "tool_call") {
        pending.turnParked.push(event.toolCall);
        onEvent?.(event);
      }
    }
    pending.buffered = [];
    await waitForTurnEnd(pending);
    pending.consumer = null;

    if (pending.turnParked.length) {
      const usage = runUsage(pending);
      return {
        text: "",
        toolCalls: pending.turnParked,
        agentID: pending.agentEntry?.agent.agentId || "",
        runID: pending.run?.id || pending.input.requestId,
        status: "tool_call",
        ...(usage ? { usage } : {})
      };
    }

    if (pending.streamError) {
      const error = pending.streamError;
      evictPendingRun(pending, "stream_error");
      throw error;
    }

    const result = await pending.run.wait();
    const text = pending.text;
    const agentEntry = pending.agentEntry;
    const runId = pending.run?.id;
    forgetPendingRun(pending);
    if (result.status === "error") {
      if (agentEntry) evictAgent(agentEntry.cacheKey, agentEntry.agent);
      throw sdkRunFailureError(result);
    }
    const finalText = !text && typeof result.result === "string" ? result.result : text;
    const usage = runUsage(pending, result);
    return {
      text: stripFinalMarker(finalText),
      toolCalls: [],
      agentID: agentEntry?.agent.agentId || "",
      runID: runId,
      status: result.status,
      ...(usage ? { usage } : {})
    };
  }

  function waitForTurnEnd(pending) {
    return new Promise((resolve) => {
      let flushTimer = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        pending.notifyParked = null;
        if (flushTimer) clearTimeout(flushTimer);
        resolve();
      };
      pending.notifyParked = () => {
        if (pending.evicted || pending.streamError) {
          done();
          return;
        }
        if (pending.streamEnded && pending.turnParked.length === 0) {
          done();
          return;
        }
        if (pending.turnParked.length) {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(done, toolFlushGraceMs);
        }
      };
      pending.notifyParked();
    });
  }

  function ingestClientToolCall(body, response) {
    const runToken = typeof body.runToken === "string" ? body.runToken.trim() : "";
    const toolName = typeof body.toolName === "string" ? body.toolName : "";
    const callId = typeof body.callId === "string" && body.callId.trim()
      ? body.callId.trim()
      : crypto.randomUUID();
    const args = isRecord(body.arguments) ? body.arguments : {};
    const pending = pendingRunForCallback(runToken);
    if (!toolName || !pending || pending.evicted) {
      return { accepted: false, callId };
    }
    const normalized = normalizeSDKToolCall({ type: toolName, args }, pending.input.clientTools);
    if (!normalized) return { accepted: false, callId };
    if (parkedMcpCalls.has(callId) || pending.parkedCallIds.has(callId)) {
      return { accepted: false, callId };
    }

    const toolCall = { ...normalized, id: callId };
    pending.parkedCallIds.add(callId);
    const timeout = setTimeout(() => {
      failParkedMcpCall(callId, "Parked client tool call timed out.");
      evictPendingRun(pending, "parked_call_timeout");
    }, currentParkedCallTimeoutMs());
    parkedMcpCalls.set(callId, {
      callId,
      runToken: pending.runToken,
      toolCall,
      response,
      timeout,
      resolved: false
    });
    if (pending.consumer?.emit) {
      pending.turnParked.push(toolCall);
      pending.consumer.emit({ type: "tool_call", toolCall });
    } else {
      pending.buffered.push({ type: "tool_call", toolCall });
    }
    pending.notifyParked?.();
    return { accepted: true, callId };
  }

  function resolveParkedMcpCall(callId, output) {
    const parked = parkedMcpCalls.get(callId);
    if (!parked || parked.resolved) return false;
    parked.resolved = true;
    clearTimeout(parked.timeout);
    parkedMcpCalls.delete(callId);
    const pending = pendingRunsByToken.get(parked.runToken);
    pending?.parkedCallIds.delete(callId);
    if (parked.response) {
      writeJson(parked.response, {
        ok: true,
        accepted: true,
        callId,
        result: mcpToolResultFromOutput(output)
      });
    }
    return true;
  }

  function failParkedMcpCall(callId, message) {
    const parked = parkedMcpCalls.get(callId);
    if (!parked || parked.resolved) return;
    parked.resolved = true;
    clearTimeout(parked.timeout);
    parkedMcpCalls.delete(callId);
    const pending = pendingRunsByToken.get(parked.runToken);
    pending?.parkedCallIds.delete(callId);
    if (parked.response) {
      writeJson(parked.response, {
        ok: true,
        accepted: true,
        callId,
        result: {
          content: [{ type: "text", text: message }],
          isError: true
        }
      });
    }
  }

  function mcpToolResultFromOutput(output) {
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return {
      content: [{ type: "text", text }],
      isError: false
    };
  }

  function evictPendingRun(pending, reason) {
    if (!pending || pending.evicted) return;
    pending.evicted = true;
    for (const callId of [...pending.parkedCallIds]) {
      failParkedMcpCall(callId, `Parked client tool call ended (${reason}).`);
    }
    pending.run?.cancel().catch(() => {});
    forgetPendingRun(pending);
    pending.notifyParked?.();
  }

  function forgetPendingRun(pending) {
    if (pendingRunsBySession.get(pending.sessionKey) === pending) {
      pendingRunsBySession.delete(pending.sessionKey);
    }
    if (pendingRunsByToken.get(pending.runToken) === pending) {
      pendingRunsByToken.delete(pending.runToken);
    }
    if (pending.mcpToken && pendingRunsByToken.get(pending.mcpToken) === pending) {
      pendingRunsByToken.delete(pending.mcpToken);
    }
  }

  function pendingRunForCallback(runToken) {
    if (runToken && pendingRunsByToken.has(runToken)) {
      return pendingRunsByToken.get(runToken);
    }
    return undefined;
  }

  function reset() {
    for (const pending of [...pendingRunsBySession.values()]) {
      evictPendingRun(pending, "test_reset");
    }
    pendingRunsBySession.clear();
    pendingRunsByToken.clear();
    parkedMcpCalls.clear();
    parkedCallTimeoutMsOverride = undefined;
  }

  function setParkedCallTimeoutMs(value) {
    parkedCallTimeoutMsOverride = value;
  }

  return {
    attachOrStart,
    beginPendingRun,
    bindRun,
    forgetPendingRun,
    attachConsumerAndWait,
    ingestClientToolCall,
    resolveParkedMcpCall,
    evictPendingRun,
    reset,
    setParkedCallTimeoutMs,
    currentParkedCallTimeoutMs
  };
}
