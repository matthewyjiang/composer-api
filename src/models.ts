export interface ComposerModel {
  id: string;
  name: string;
  inputCost: number;
  outputCost: number;
  contextWindow: number;
  outputLimit: number;
}

export const COMPOSER_MODELS: ComposerModel[] = [
  { id: "composer-2.5", name: "Composer 2.5", inputCost: 0.5, outputCost: 2.5, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast", inputCost: 3, outputCost: 15, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "grok-4.6", name: "Grok 4.6", inputCost: 2, outputCost: 6, contextWindow: 256_000, outputLimit: 65_536 },
  { id: "grok-4.6-fast", name: "Grok 4.6 Fast", inputCost: 4, outputCost: 12, contextWindow: 256_000, outputLimit: 65_536 },
  { id: "grok-4.5", name: "Grok 4.5", inputCost: 2, outputCost: 6, contextWindow: 200_000, outputLimit: 65_536 },
  { id: "grok-4.5-fast", name: "Grok 4.5 Fast", inputCost: 4, outputCost: 18, contextWindow: 200_000, outputLimit: 65_536 }
];

const MODEL_ALIASES: Record<string, string> = {
  default: "composer-2.5",
  auto: "composer-2.5",
  composer: "composer-2.5",
  "composer-latest": "composer-2.5",
  "composer-2-5": "composer-2.5",
  "composer-2.5-sdk": "composer-2.5",
  "composer-2-5-sdk": "composer-2.5",
  "composer-2-5-fast": "composer-2.5-fast",
  "grok-4-6": "grok-4.6",
  "grok-4-6-fast": "grok-4.6-fast",
  "grok-4-5": "grok-4.5",
  "grok-4-5-fast": "grok-4.5-fast"
};

export function resolveCursorModel(model: unknown): { id: string } {
  if (typeof model !== "string" || !model.trim()) return { id: "composer-2.5" };
  const normalized = model.trim().toLowerCase().split("/").filter(Boolean).at(-1) || "";
  const aliased = MODEL_ALIASES[normalized];
  if (aliased) return { id: aliased };
  const known = COMPOSER_MODELS.find((item) => item.id.toLowerCase() === normalized || item.id.replaceAll(".", "-") === normalized);
  if (known) return { id: known.id };
  return { id: model.trim() };
}

export function modelById(id: string): ComposerModel | undefined {
  const resolved = resolveCursorModel(id).id;
  return COMPOSER_MODELS.find((item) => item.id === resolved);
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
      output: model.outputCost
    },
    limit: {
      context: model.contextWindow,
      output: model.outputLimit
    }
  };
}
