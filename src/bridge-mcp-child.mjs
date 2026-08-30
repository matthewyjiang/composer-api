import readline from "node:readline";

export function parseClientMcpToolsJSON(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function runClientForwardingMcpServer({
  tools,
  callbackUrl,
  callbackToken,
  callbackCacheKey,
  callbackRunToken,
  parkedCallTimeoutMs: parkedTimeoutMs = 120 * 1000,
  input = process.stdin,
  output = process.stdout,
  validateClientMcpToolCall
}) {
  const rl = readline.createInterface({ input });
  let outputClosed = false;
  const writeOutput = (payload) => {
    if (outputClosed) return false;
    try {
      return output.write(payload);
    } catch (error) {
      if (!isBenignPipeError(error)) throw error;
      outputClosed = true;
      return false;
    }
  };
  output.on?.("error", (error) => {
    outputClosed = true;
    if (!isBenignPipeError(error)) process.exitCode = 1;
  });
  const send = (id, result) => {
    if (id === undefined || id === null) return;
    writeOutput(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const sendError = (id, message) => {
    if (id === undefined || id === null) return;
    writeOutput(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  };
  const pending = new Set();

  const handleLine = async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message.id && String(message.method || "").startsWith("notifications/")) return;
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "api-for-cursor-client-tools", version: "0.1.0" }
      });
      return;
    }
    if (message.method === "tools/list") {
      send(message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      const toolName = params.name || params.toolName;
      const toolInput = params.arguments || params.input || {};
      const validationError = validateClientMcpToolCall(tools, toolName, toolInput);
      if (validationError) {
        sendError(message.id, validationError);
        return;
      }
      const callId = crypto.randomUUID();
      const outcome = await notifyParentToolCall({
        callbackUrl,
        callbackToken,
        callbackCacheKey,
        callbackRunToken,
        callId,
        toolName,
        input: toolInput,
        timeoutMs: parkedTimeoutMs
      });
      if (!outcome || outcome.accepted !== true) {
        sendError(message.id, "Outer client callback unavailable for forwarded tool call.");
        return;
      }
      if (outcome.result) {
        send(message.id, outcome.result);
        return;
      }
      send(message.id, {
        content: [{ type: "text", text: typeof outcome.output === "string" ? outcome.output : "" }],
        isError: false
      });
      return;
    }
    sendError(message.id, `Unsupported MCP method: ${message.method}`);
  };

  await new Promise((resolve) => {
    rl.on("line", (line) => {
      const task = handleLine(line)
        .catch((error) => {
          if (!isBenignPipeError(error)) process.exitCode = 1;
        })
        .finally(() => {
          pending.delete(task);
        });
      pending.add(task);
    });
    rl.on("close", async () => {
      await Promise.allSettled([...pending]);
      resolve();
    });
  });
}

export async function notifyParentToolCall({
  callbackUrl,
  callbackToken,
  callbackCacheKey,
  callbackRunToken,
  callId,
  toolName,
  input,
  timeoutMs
}) {
  if (!callbackUrl || !callbackCacheKey) return { accepted: true, result: { content: [{ type: "text", text: "" }], isError: false } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, (timeoutMs || 120 * 1000) + 5000));
  try {
    const headers = { "Content-Type": "application/json" };
    if (callbackToken) headers.Authorization = `Bearer ${callbackToken}`;
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cacheKey: callbackCacheKey,
        runToken: callbackRunToken,
        callId,
        toolName,
        arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {}
      }),
      signal: controller.signal
    });
    if (!response.ok) return { accepted: false };
    const body = await response.json().catch(() => ({}));
    return body && typeof body === "object" ? body : { accepted: false };
  } catch {
    return { accepted: false };
  } finally {
    clearTimeout(timer);
  }
}

function isBenignPipeError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}
