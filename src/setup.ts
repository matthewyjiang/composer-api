import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baseUrl, configHome, DISPLAY_NAME, type AppConfig } from "./config.js";
import { agentModelDefinition, COMPOSER_MODELS } from "./models.js";

export const SETUP_AGENTS = ["opencode", "codex", "vscode", "cline", "kilo", "pi", "rho"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];

export interface SetupResult {
  id: SetupAgent;
  configPath: string;
  detail: string;
}

export async function setupAgent(id: SetupAgent, config: AppConfig, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<SetupResult> {
  const ctx = { config, home, env, configHome: configHome(env, home) };
  switch (id) {
    case "opencode":
      return installOpenCode(ctx);
    case "codex":
      return installCodex(ctx);
    case "vscode":
      return installVSCode(ctx);
    case "cline":
      return installCline(ctx);
    case "kilo":
      return installKilo(ctx);
    case "pi":
      return installPi(ctx);
    case "rho":
      return installRho(ctx);
  }
}

export async function setupAll(config: AppConfig, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  for (const id of SETUP_AGENTS) {
    results.push(await setupAgent(id, config, home, env));
  }
  return results;
}

interface SetupContext {
  config: AppConfig;
  home: string;
  env: NodeJS.ProcessEnv;
  configHome: string;
}

async function installOpenCode(ctx: SetupContext): Promise<SetupResult> {
  const configPath = path.join(ctx.configHome, "opencode", "opencode.json");
  const root = await readJsonObject(configPath);
  const provider = isRecord(root.provider) ? root.provider : {};
  delete provider.cursor;
  delete provider.cursorsdk;
  provider.cursorapi = {
    npm: "@ai-sdk/openai-compatible",
    name: DISPLAY_NAME,
    options: {
      baseURL: baseUrl(ctx.config),
      apiKey: "cursor-local"
    },
    models: Object.fromEntries(COMPOSER_MODELS.map((model) => [model.id, agentModelDefinition(model)]))
  };
  root.provider = provider;
  if (typeof root.model === "string" && (root.model.startsWith("cursor/") || root.model.startsWith("cursorsdk/"))) {
    root.model = "cursorapi/composer-2.5-fast";
  } else if (root.model == null) {
    root.model = "cursorapi/composer-2.5-fast";
  }
  await writeJson(configPath, root);
  return { id: "opencode", configPath, detail: "OpenCode provider installed" };
}

async function installCodex(ctx: SetupContext): Promise<SetupResult> {
  const configPath = path.join(ctx.home, ".codex", "config.toml");
  let text = await readText(configPath);
  for (const name of ["model_providers.cursorapi.auth", "model_providers.cursorapi", "profiles.cursorapi", "profiles.cursorapi-fast"]) {
    text = replaceTomlBlock(text, name, "");
  }
  text = text.trim();
  const block = `
[model_providers.cursorapi]
name = "${DISPLAY_NAME}"
base_url = "${baseUrl(ctx.config)}"
wire_api = "responses"

[model_providers.cursorapi.auth]
command = "/bin/echo"
args = ["cursor-local"]
refresh_interval_ms = 300000
`.trim();
  text = text ? `${text}\n\n${block}\n` : `${block}\n`;
  await writeText(configPath, text);
  await writeText(path.join(ctx.home, ".codex", "cursorapi.config.toml"), "model_provider = \"cursorapi\"\nmodel = \"composer-2.5\"\n");
  await writeText(path.join(ctx.home, ".codex", "cursorapi-fast.config.toml"), "model_provider = \"cursorapi\"\nmodel = \"composer-2.5-fast\"\n");
  return { id: "codex", configPath, detail: "Codex provider installed" };
}

async function installVSCode(ctx: SetupContext): Promise<SetupResult> {
  const configPath = vscodeLanguageModelsPath(ctx);
  const models = await readJsonArray(configPath);
  const filtered = models.filter((item) => {
    if (!isRecord(item)) return true;
    return item.name !== "CursorAPI" && item.name !== DISPLAY_NAME;
  });
  filtered.push({
    name: DISPLAY_NAME,
    provider: "openai-compatible",
    baseUrl: baseUrl(ctx.config),
    models: COMPOSER_MODELS.map((model) => model.id)
  });
  await writeJson(configPath, filtered);
  return { id: "vscode", configPath, detail: "VS Code model metadata installed" };
}

async function installCline(ctx: SetupContext): Promise<SetupResult> {
  const configPath = path.join(ctx.home, ".cline", "data", "globalState.json");
  const globalState = await readJsonObject(configPath);
  globalState.actModeApiProvider = "openai";
  globalState.planModeApiProvider = "openai";
  globalState.actModeOpenAiModelId = "composer-2.5";
  globalState.planModeOpenAiModelId = "composer-2.5-fast";
  globalState.actModeOpenAiModelInfo = clineModelInfo("composer-2.5");
  globalState.planModeOpenAiModelInfo = clineModelInfo("composer-2.5-fast");
  globalState.openAiHeaders = {};
  globalState.openAiBaseUrl = baseUrl(ctx.config);
  globalState.welcomeViewCompleted = true;
  if (globalState.remoteRulesToggles == null) globalState.remoteRulesToggles = {};
  if (globalState.remoteWorkflowToggles == null) globalState.remoteWorkflowToggles = {};
  await writeJson(configPath, globalState);
  await writeJson(path.join(ctx.home, ".cline", "data", "secrets.json"), {
    ...(await readJsonObject(path.join(ctx.home, ".cline", "data", "secrets.json"))),
    openAiApiKey: "cursor-local"
  });
  return { id: "cline", configPath, detail: "Cline provider profile installed" };
}

async function installKilo(ctx: SetupContext): Promise<SetupResult> {
  const configPath = path.join(ctx.configHome, "kilo", "kilo.jsonc");
  const root = await readJsonObject(configPath, { $schema: "https://app.kilo.ai/config.json" });
  const provider = isRecord(root.provider) ? root.provider : {};
  provider.cursorapi = {
    options: {
      baseURL: baseUrl(ctx.config),
      apiKey: "cursor-local"
    },
    models: Object.fromEntries(COMPOSER_MODELS.map((model) => [model.id, agentModelDefinition(model)]))
  };
  root.provider = provider;
  if (root.model == null) root.model = "cursorapi/composer-2.5";
  await writeJson(configPath, root);
  return { id: "kilo", configPath, detail: "Kilo provider installed" };
}

async function installPi(ctx: SetupContext): Promise<SetupResult> {
  const configPath = path.join(ctx.home, ".pi", "agent", "models.json");
  const root = await readJsonObject(configPath, { providers: {} });
  const providers = isRecord(root.providers) ? root.providers : {};
  providers.cursorapi = {
    baseUrl: baseUrl(ctx.config),
    apiKey: "cursor-local",
    authHeader: true,
    api: "openai-completions",
    models: COMPOSER_MODELS.map((model) => ({
      ...agentModelDefinition(model),
      id: model.id,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.outputLimit,
      cost: {
        input: model.inputCost,
        output: model.outputCost,
        cacheRead: 0,
        cacheWrite: 0
      },
      compat: {
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresAssistantAfterToolResult: false
      }
    }))
  };
  root.providers = providers;
  await writeJson(configPath, root);
  return { id: "pi", configPath, detail: "Pi provider installed" };
}

async function installRho(ctx: SetupContext): Promise<SetupResult> {
  const rhoHome = ctx.env.RHO_HOME?.trim() || path.join(ctx.home, ".rho");
  const configPath = path.join(rhoHome, "config.toml");
  let text = await readText(configPath);
  text = replaceTomlBlock(text, "providers.custom.cursorapi", "").trim();
  const block = `
[providers.custom.cursorapi]
base_url = "${baseUrl(ctx.config)}"
api = "responses"
`.trim();
  text = text ? `${text}\n\n${block}\n` : `${block}\n`;
  await writeText(configPath, text);
  return { id: "rho", configPath, detail: "Rho provider installed" };
}

function vscodeLanguageModelsPath(ctx: SetupContext): string {
  const names = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
  for (const name of names) {
    const candidate = path.join(ctx.configHome, name, "User", "chatLanguageModels.json");
    // Prefer an existing editor user dir if present; otherwise default to Code.
    if (ctx.env[`CURSOR_API_VSCODE_APP`] === name) return candidate;
  }
  return path.join(ctx.configHome, "Code", "User", "chatLanguageModels.json");
}

function clineModelInfo(id: string): Record<string, unknown> {
  const model = COMPOSER_MODELS.find((item) => item.id === id) ?? COMPOSER_MODELS[0];
  return {
    maxTokens: model.outputLimit,
    contextWindow: model.contextWindow,
    supportsImages: true,
    supportsPromptCache: false,
    inputPrice: model.inputCost,
    outputPrice: model.outputCost,
    temperature: 0,
    supportsTools: true,
    supportsStreaming: true,
    systemRole: "system"
  };
}

function replaceTomlBlock(text: string, name: string, replacement: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[${escaped}\\]\\n[\\s\\S]*?(?=^\\[|$(?![\\s\\S]))`, "m");
  return text.replace(pattern, replacement ? `${replacement}\n` : "");
}

async function readJsonObject(filePath: string, fallback: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const text = await readText(filePath);
  if (!text.trim()) return { ...fallback };
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

async function readJsonArray(filePath: string): Promise<unknown[]> {
  const text = await readText(filePath);
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
