import { HttpError } from "./http.js";

export interface ComposerModel {
  id: string;
  name: string;
  inputCost: number;
  /** Cache-read price per million tokens (Cursor published). */
  cacheReadCost: number;
  outputCost: number;
  contextWindow: number;
  outputLimit: number;
}

export interface ModelParam {
  id: string;
  value: string;
}

/** Resolved Cursor SDK model selection for a request. */
export interface ResolvedCursorModel {
  /** OpenAI-facing model id (normalized when known). */
  id: string;
  /** Base model id passed to the Cursor SDK. */
  sdkId: string;
  /** Cursor SDK model params (fast, effort/reasoning, …). */
  params: ModelParam[];
  /** Effective reasoning effort for response echo, if set. */
  reasoningEffort: string | null;
}

type ReasoningParamId = "effort" | "reasoning";

interface ModelFamily {
  /** Canonical public base id (without -fast / effort suffixes). */
  baseId: string;
  /** Public catalog ids for /v1/models (base + fast when applicable). */
  catalogIds: string[];
  aliases?: string[];
  supportsFast: boolean;
  /** Cursor param used for thinking depth. */
  reasoningParam?: ReasoningParamId;
  /** Allowed values for that reasoning param. */
  reasoningValues?: readonly string[];
  /** Map OpenAI-ish aliases onto a Cursor value for this family. */
  normalizeReasoning?: (value: string) => string | undefined;
}

const GROK_46_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const GROK_45_EFFORTS = ["low", "medium", "high"] as const;

function identityEffort(value: string): string | undefined {
  const normalized = canonicalizeEffortToken(value);
  return normalized;
}

function grokEffort(allowed: readonly string[]) {
  return (value: string): string | undefined => {
    const token = canonicalizeEffortToken(value);
    if (!token) return undefined;
    // OpenAI "extra-high" / "xhigh" both mean xhigh on Grok 4.6.
    const mapped = token === "extra-high" ? "xhigh" : token;
    return allowed.includes(mapped) ? mapped : undefined;
  };
}

function gptReasoning(value: string): string | undefined {
  const token = canonicalizeEffortToken(value);
  if (!token) return undefined;
  // Cursor GPT catalog uses extra-high; accept xhigh as an alias.
  if (token === "xhigh") return "extra-high";
  return token;
}

const MODEL_FAMILIES: ModelFamily[] = [
  {
    baseId: "composer-2.5",
    catalogIds: ["composer-2.5", "composer-2.5-fast"],
    aliases: ["default", "auto", "composer", "composer-latest", "composer-2-5", "composer-2.5-sdk", "composer-2-5-sdk"],
    supportsFast: true
  },
  {
    baseId: "grok-4.6",
    catalogIds: ["grok-4.6", "grok-4.6-fast"],
    aliases: ["grok-4-6"],
    supportsFast: true,
    reasoningParam: "effort",
    reasoningValues: GROK_46_EFFORTS,
    normalizeReasoning: grokEffort(GROK_46_EFFORTS)
  },
  {
    baseId: "grok-4.5",
    catalogIds: ["grok-4.5", "grok-4.5-fast"],
    aliases: ["grok-4-5"],
    supportsFast: true,
    reasoningParam: "effort",
    reasoningValues: GROK_45_EFFORTS,
    normalizeReasoning: grokEffort(GROK_45_EFFORTS)
  }
];

/** Heuristic families for passthrough model ids (not in the public catalog). */
const PASSTHROUGH_REASONING: Array<{
  match: (sdkId: string) => boolean;
  reasoningParam: ReasoningParamId;
  normalizeReasoning: (value: string) => string | undefined;
  supportsFast?: boolean;
}> = [
  {
    match: (id) => /^(gpt|codex|o\d|kimi|glm)/i.test(id),
    reasoningParam: "reasoning",
    normalizeReasoning: gptReasoning,
    supportsFast: true
  },
  {
    match: (id) => /^(claude|gemini|grok|fable|sonnet|opus)/i.test(id),
    reasoningParam: "effort",
    normalizeReasoning: identityEffort,
    supportsFast: true
  }
];

export const COMPOSER_MODELS: ComposerModel[] = [
  { id: "composer-2.5", name: "Composer 2.5", inputCost: 0.5, cacheReadCost: 0.2, outputCost: 2.5, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast", inputCost: 3, cacheReadCost: 0.5, outputCost: 15, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "grok-4.6", name: "Grok 4.6", inputCost: 2, cacheReadCost: 0.5, outputCost: 6, contextWindow: 256_000, outputLimit: 65_536 },
  { id: "grok-4.6-fast", name: "Grok 4.6 Fast", inputCost: 4, cacheReadCost: 1, outputCost: 12, contextWindow: 256_000, outputLimit: 65_536 },
  { id: "grok-4.5", name: "Grok 4.5", inputCost: 2, cacheReadCost: 0.5, outputCost: 6, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "grok-4.5-fast", name: "Grok 4.5 Fast", inputCost: 4, cacheReadCost: 1, outputCost: 18, contextWindow: 200_000, outputLimit: 65_536 }
];

const EFFORT_SUFFIXES = [
  "extra-high",
  "extra_high",
  "xhigh",
  "minimal",
  "medium",
  "none",
  "low",
  "high",
  "max"
] as const;

/**
 * Parse OpenAI-compatible reasoning controls from a request body.
 * Accepts Chat Completions `reasoning_effort` and Responses `reasoning.effort`.
 * When both are present, `reasoning_effort` wins.
 */
export function reasoningEffortFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.reasoning_effort === "string" && record.reasoning_effort.trim()) {
    return record.reasoning_effort.trim();
  }
  if (record.reasoning && typeof record.reasoning === "object" && !Array.isArray(record.reasoning)) {
    const effort = (record.reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort.trim()) return effort.trim();
  }
  return undefined;
}

/**
 * Resolve a client model id (and optional body reasoning effort) into a Cursor SDK selection.
 * Body effort overrides effort encoded in the model id (e.g. grok-4.6-high-fast).
 */
export function resolveCursorModel(
  model: unknown,
  options: { reasoningEffort?: string | null } = {}
): ResolvedCursorModel {
  const raw = typeof model === "string" && model.trim() ? model.trim() : "composer-2.5";
  const leaf = raw.toLowerCase().split("/").filter(Boolean).at(-1) || "composer-2.5";
  const parsed = parseModelLeaf(leaf);
  const family = findFamily(parsed.baseKey);

  // Body effort overrides effort encoded in the model id.
  const requestedEffort =
    typeof options.reasoningEffort === "string" && options.reasoningEffort.trim()
      ? options.reasoningEffort.trim()
      : parsed.effort;

  if (family) {
    return resolveKnownFamily(family, parsed, requestedEffort);
  }
  return resolvePassthrough(parsed, requestedEffort, raw);
}

function resolveKnownFamily(
  family: ModelFamily,
  parsed: ParsedModelLeaf,
  requestedEffort: string | undefined
): ResolvedCursorModel {
  const fast = family.supportsFast ? parsed.fast : false;
  const params: ModelParam[] = [];
  if (family.supportsFast) {
    params.push({ id: "fast", value: fast ? "true" : "false" });
  }

  let reasoningEffort: string | null = null;
  if (requestedEffort !== undefined) {
    if (!family.reasoningParam || !family.normalizeReasoning) {
      throw new HttpError(
        `Model '${family.baseId}' does not support reasoning effort.`,
        400,
        "unsupported_parameter",
        "reasoning.effort"
      );
    }
    const normalized = family.normalizeReasoning(requestedEffort);
    if (!normalized) {
      const allowed = family.reasoningValues?.join(", ") ?? "see Cursor model catalog";
      throw new HttpError(
        `Invalid reasoning effort '${requestedEffort}' for ${family.baseId}. Allowed: ${allowed}.`,
        400,
        "invalid_request",
        "reasoning.effort"
      );
    }
    params.push({ id: family.reasoningParam, value: normalized });
    reasoningEffort = normalized;
  }

  const publicId = publicIdFor(family.baseId, fast, reasoningEffort);
  return {
    id: publicId,
    sdkId: family.baseId,
    params,
    reasoningEffort
  };
}

function resolvePassthrough(
  parsed: ParsedModelLeaf,
  requestedEffort: string | undefined,
  raw: string
): ResolvedCursorModel {
  const sdkId = parsed.baseKey.includes(".") || parsed.baseKey.includes("-")
    ? restoreBaseId(parsed.baseKey, raw)
    : parsed.baseKey || raw;
  const hint = PASSTHROUGH_REASONING.find((item) => item.match(sdkId));
  const params: ModelParam[] = [];
  // Only set fast when the client encoded it in the id; unknown models may not support it.
  if (parsed.fast) params.push({ id: "fast", value: "true" });
  else if (hint?.supportsFast && parsed.baseKey !== sdkId.toLowerCase()) {
    // no-op: don't force fast=false on unknown models
  }

  let reasoningEffort: string | null = null;
  if (requestedEffort !== undefined) {
    const paramId = hint?.reasoningParam ?? "effort";
    const normalized = hint?.normalizeReasoning(requestedEffort) ?? canonicalizeEffortToken(requestedEffort);
    if (!normalized) {
      throw new HttpError(
        `Invalid reasoning effort '${requestedEffort}'.`,
        400,
        "invalid_request",
        "reasoning.effort"
      );
    }
    params.push({ id: paramId, value: normalized });
    reasoningEffort = normalized;
  }

  return {
    id: raw.trim(),
    sdkId,
    params,
    reasoningEffort
  };
}

interface ParsedModelLeaf {
  /** Lowercase base key used for family lookup (dots preserved when present). */
  baseKey: string;
  fast: boolean;
  effort?: string;
}

function parseModelLeaf(leaf: string): ParsedModelLeaf {
  let rest = leaf;
  let fast = false;
  let effort: string | undefined;

  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -"-fast".length);
  }

  // Peel trailing effort after optional -fast (e.g. grok-4.6-high-fast → high + fast).
  for (const suffix of EFFORT_SUFFIXES) {
    const token = `-${suffix}`;
    if (rest.endsWith(token)) {
      effort = canonicalizeEffortToken(suffix);
      rest = rest.slice(0, -token.length);
      break;
    }
  }

  const aliasHit = matchAlias(rest);
  if (aliasHit) {
    return { baseKey: aliasHit, fast, effort };
  }

  return { baseKey: rest, fast, effort };
}

function matchAlias(baseKey: string): string | undefined {
  const dotted = baseKey;
  const dashed = baseKey.replaceAll(".", "-");
  for (const family of MODEL_FAMILIES) {
    if (family.baseId === dotted || family.baseId.replaceAll(".", "-") === dashed) return family.baseId;
    for (const alias of family.aliases ?? []) {
      if (alias === dotted || alias === dashed) return family.baseId;
    }
    for (const catalogId of family.catalogIds) {
      if (catalogId === dotted || catalogId.replaceAll(".", "-") === dashed) {
        // catalog id like grok-4.6-fast already handled via peel; base catalog id
        if (catalogId === family.baseId || catalogId === `${family.baseId}-fast`) return family.baseId;
      }
    }
  }
  return undefined;
}

function findFamily(baseKey: string): ModelFamily | undefined {
  const matched = matchAlias(baseKey);
  if (matched) return MODEL_FAMILIES.find((family) => family.baseId === matched);
  return MODEL_FAMILIES.find(
    (family) =>
      family.baseId === baseKey ||
      family.baseId.replaceAll(".", "-") === baseKey ||
      (family.aliases ?? []).includes(baseKey)
  );
}

function publicIdFor(baseId: string, fast: boolean, effort: string | null): string {
  const parts = [baseId];
  if (effort) parts.push(effort);
  if (fast) parts.push("fast");
  // Keep catalog-stable ids when no effort was requested.
  if (!effort) return fast ? `${baseId}-fast` : baseId;
  return parts.join("-");
}

function restoreBaseId(baseKey: string, raw: string): string {
  // Prefer original casing/path leaf without suffixes when possible.
  const leaf = raw.split("/").filter(Boolean).at(-1) || raw;
  let rest = leaf;
  if (/-fast$/i.test(rest)) rest = rest.replace(/-fast$/i, "");
  for (const suffix of EFFORT_SUFFIXES) {
    const re = new RegExp(`-${suffix}$`, "i");
    if (re.test(rest)) {
      rest = rest.replace(re, "");
      break;
    }
  }
  return rest || baseKey;
}

/** Canonicalize free-form effort tokens into a stable lowercase form. */
export function canonicalizeEffortToken(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (!normalized) return undefined;
  if (normalized === "extra-high" || normalized === "extrahigh") return "extra-high";
  if (normalized === "x-high") return "xhigh";
  return normalized;
}

export function modelById(id: string): ComposerModel | undefined {
  const resolved = resolveCursorModel(id);
  // Map effort variants back to catalog pricing row (base or fast).
  const catalogId = resolved.params.some((param) => param.id === "fast" && param.value === "true")
    ? `${resolved.sdkId}-fast`
    : resolved.sdkId;
  return COMPOSER_MODELS.find((item) => item.id === catalogId || item.id === resolved.sdkId);
}

export function localModelList(): Record<string, unknown> {
  return {
    object: "list",
    data: COMPOSER_MODELS.map(modelObject)
  };
}

export function modelObject(model: ComposerModel): Record<string, unknown> {
  return {
    id: model.id,
    object: "model",
    created: 1_779_148_800,
    owned_by: "cursor"
  };
}

export function agentModelDefinition(model: ComposerModel): Record<string, unknown> {
  return {
    name: model.name,
    cost: {
      input: model.inputCost,
      cache_read: model.cacheReadCost,
      output: model.outputCost
    },
    limit: {
      context: model.contextWindow,
      output: model.outputLimit
    }
  };
}
