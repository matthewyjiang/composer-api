import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupAgent, setupAll } from "./setup.js";
import type { AppConfig } from "./config.js";

function config(home: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    cursorApiKey: "test-key",
    configPath: path.join(home, "config.json")
  };
}

describe("agent setup", () => {
  it("writes an OpenCode provider pointing at the local base URL", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-setup-"));
    const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
    const result = await setupAgent("opencode", config(home), home, env);
    const parsed = JSON.parse(await readFile(result.configPath, "utf8")) as {
      provider: { cursorapi: { options: { baseURL: string } } };
      model: string;
    };
    expect(parsed.provider.cursorapi.options.baseURL).toBe("http://127.0.0.1:8787/v1");
    expect(parsed.model).toBe("cursorapi/composer-2.5-fast");
  });

  it("writes Codex provider and profile files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-setup-"));
    const result = await setupAgent("codex", config(home), home, {});
    const text = await readFile(result.configPath, "utf8");
    expect(text).toContain("[model_providers.cursorapi]");
    expect(text).toContain('base_url = "http://127.0.0.1:8787/v1"');
    const profile = await readFile(path.join(home, ".codex", "cursorapi.config.toml"), "utf8");
    expect(profile).toContain("composer-2.5");
  });

  it("writes VS Code metadata under XDG config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-setup-"));
    const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
    const result = await setupAgent("vscode", config(home), home, env);
    expect(result.configPath).toBe(path.join(home, ".config", "Code", "User", "chatLanguageModels.json"));
    const parsed = JSON.parse(await readFile(result.configPath, "utf8")) as Array<{ baseUrl: string }>;
    expect(parsed[0].baseUrl).toBe("http://127.0.0.1:8787/v1");
  });

  it("installs every supported agent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-setup-"));
    const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
    const results = await setupAll(config(home), home, env);
    expect(results.map((item) => item.id)).toEqual(["opencode", "codex", "vscode", "cline", "kilo", "pi"]);
  });
});
