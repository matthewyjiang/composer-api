import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DISPLAY_NAME = "API for Cursor";
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

export interface AppConfig {
  host: string;
  port: number;
  cursorApiKey: string;
  configPath: string;
}

export interface ConfigFile {
  host?: string;
  port?: number;
  cursorApiKey?: string;
}

const PLACEHOLDER_TOKENS = new Set(["", "local", "cursor-local", "CURSOR_API_KEY", "{env:CURSOR_API_KEY}"]);

export function configHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && xdg.startsWith("/")) return xdg;
  return path.join(home, ".config");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(configHome(env, home), "api-for-cursor", "config.json");
}

export async function loadConfig(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  configPath?: string;
  host?: string;
  port?: number;
  cursorApiKey?: string;
} = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configPath = options.configPath || env.CURSOR_API_CONFIG || defaultConfigPath(env, home);
  const file = await readConfigFile(configPath);
  const cursorApiKey =
    firstNonEmpty(options.cursorApiKey, env.CURSOR_API_KEY, file.cursorApiKey) ?? "";
  const host = firstNonEmpty(options.host, env.CURSOR_API_HOST, file.host) ?? DEFAULT_HOST;
  const port = parsePort(options.port ?? env.CURSOR_API_PORT ?? file.port) ?? DEFAULT_PORT;
  return { host, port, cursorApiKey, configPath };
}

export async function saveApiKey(apiKey: string, configPath?: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<string> {
  const target = configPath || env.CURSOR_API_CONFIG || defaultConfigPath(env, home);
  const current = await readConfigFile(target);
  current.cursorApiKey = apiKey.trim();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export function isPlaceholderToken(token: string | undefined): boolean {
  const normalized = token?.trim() ?? "";
  return PLACEHOLDER_TOKENS.has(normalized);
}

export function resolveRequestApiKey(authorization: string | undefined, configuredKey: string): string {
  const bearer = bearerToken(authorization);
  if (bearer && !isPlaceholderToken(bearer)) return bearer;
  return configuredKey.trim();
}

export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match) return match[1].trim();
  return undefined;
}

export function baseUrl(config: Pick<AppConfig, "host" | "port">): string {
  return `http://${config.host}:${config.port}/v1`;
}

async function readConfigFile(configPath: string): Promise<ConfigFile> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      host: typeof record.host === "string" ? record.host : undefined,
      port: typeof record.port === "number" ? record.port : undefined,
      cursorApiKey: typeof record.cursorApiKey === "string" ? record.cursorApiKey : undefined
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function parsePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
