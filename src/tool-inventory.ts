import type { OpenAiToolSpec } from "./openai.js";

const TOOL_DESCRIPTION_LIMIT = 160;
const SCHEMA_NOISE_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "examples",
  "default",
  "markdownDescription"
]);

export function compactToolDescription(description: string | undefined): string | undefined {
  if (typeof description !== "string") return undefined;
  const trimmed = description.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > TOOL_DESCRIPTION_LIMIT ? `${trimmed.slice(0, TOOL_DESCRIPTION_LIMIT - 3)}...` : trimmed;
}

export function compactJsonSchema(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => compactJsonSchema(item, depth + 1));
  if (!isRecord(value)) return value;
  const compact: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SCHEMA_NOISE_KEYS.has(key)) continue;
    if (key === "description") {
      if (depth === 0) {
        const description = compactToolDescription(typeof nested === "string" ? nested : undefined);
        if (description) compact.description = description;
      }
      continue;
    }
    if (key === "additionalProperties" && nested === true) continue;
    compact[key] = compactJsonSchema(nested, depth + 1);
  }
  return compact;
}

export function routedToolInventoryRecord(tool: OpenAiToolSpec): Record<string, unknown> {
  const description = compactToolDescription(tool.description);
  return {
    name: tool.name,
    ...(description ? { description } : {}),
    via: "SDK TOOL ROUTING MAP"
  };
}

export function appendCompactToolRecords(
  transcript: string[],
  tools: OpenAiToolSpec[],
  routes: Record<string, unknown>[],
  inventoryRecord: (tool: OpenAiToolSpec) => Record<string, unknown>
) {
  const routedClients = new Set(
    routes.flatMap((route) => (
      typeof route.client === "string" && route.sdk !== "mcp" ? [route.client] : []
    ))
  );
  for (const tool of tools) {
    transcript.push(JSON.stringify(
      routedClients.has(tool.name)
        ? routedToolInventoryRecord(tool)
        : inventoryRecord(tool)
    ));
  }
}

export function appendSdkRoutingMap(transcript: string[], routes: Record<string, unknown>[]) {
  if (!routes.length) return;
  transcript.push(
    "SDK TOOL ROUTING MAP:",
    "Use these SDK tool names; the adapter forwards them to the listed client tool and argument shape."
  );
  for (const route of routes) {
    transcript.push(JSON.stringify(route));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
