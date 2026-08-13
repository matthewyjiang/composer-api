import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, isPlaceholderToken, loadConfig, resolveRequestApiKey, saveApiKey } from "./config.js";

describe("config", () => {
  it("loads host, port, and key from env over an empty config file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-config-"));
    const config = await loadConfig({
      home,
      env: {
        XDG_CONFIG_HOME: path.join(home, ".config"),
        CURSOR_API_KEY: "env-key",
        CURSOR_API_HOST: "10.0.0.1",
        CURSOR_API_PORT: "9000"
      }
    });
    expect(config.cursorApiKey).toBe("env-key");
    expect(config.host).toBe("10.0.0.1");
    expect(config.port).toBe(9000);
    expect(config.configPath).toBe(path.join(home, ".config", "api-for-cursor", "config.json"));
  });

  it("saves the API key with mode-safe JSON", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-config-"));
    const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
    const saved = await saveApiKey("sk-test", undefined, env, home);
    const parsed = JSON.parse(await readFile(saved, "utf8")) as { cursorApiKey: string };
    expect(parsed.cursorApiKey).toBe("sk-test");
    const config = await loadConfig({ home, env });
    expect(config.cursorApiKey).toBe("sk-test");
  });

  it("treats local client tokens as placeholders", () => {
    expect(isPlaceholderToken("local")).toBe(true);
    expect(isPlaceholderToken("cursor-local")).toBe(true);
    expect(resolveRequestApiKey("Bearer local", "real-key")).toBe("real-key");
    expect(resolveRequestApiKey("Bearer sk-live", "real-key")).toBe("sk-live");
  });

  it("uses an explicit config path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-config-"));
    const configPath = path.join(home, "custom.json");
    await mkdir(home, { recursive: true });
    await writeFile(configPath, JSON.stringify({ port: 8123, cursorApiKey: "file-key" }));
    const config = await loadConfig({ home, configPath, env: {} });
    expect(config.port).toBe(8123);
    expect(config.cursorApiKey).toBe("file-key");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: path.join(home, ".config") }, home)).toContain("api-for-cursor");
  });
});
