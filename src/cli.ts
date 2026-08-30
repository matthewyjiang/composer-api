#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import { baseUrl, DISPLAY_NAME, loadConfig, saveApiKey, type AppConfig } from "./config.js";
import { incomingToRequest, writeNodeResponse } from "./node-http.js";
import { COMPOSER_MODELS } from "./models.js";
import { createContext, handleRequest } from "./server.js";
import { installUserService, uninstallUserService } from "./service.js";
import { SETUP_AGENTS, setupAgent, setupAll, type SetupAgent } from "./setup.js";

const HELP = `${DISPLAY_NAME}

Usage:
  cursor-api serve [options]
  cursor-api set-key <cursor-api-key>
  cursor-api setup [opencode|codex|vscode|cline|kilo|pi|rho|all]
  cursor-api install-service
  cursor-api uninstall-service
  cursor-api models
  cursor-api help

Options:
  --host <host>       Listen address (default 127.0.0.1)
  --port, -p <port>   Listen port (default 8787)
  --key <key>         Cursor API key (else CURSOR_API_KEY or config file)
  --config <path>     Config file path

A Cursor user API key comes from the Cursor Dashboard under Integrations.
`;

interface CliOptions {
  command: string;
  args: string[];
  host?: string;
  port?: number;
  key?: string;
  config?: string;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const config = await loadConfig({
    configPath: options.config,
    host: options.host,
    port: options.port,
    cursorApiKey: options.key
  });

  if (options.command === "models") {
    for (const model of COMPOSER_MODELS) {
      process.stdout.write(`${model.id}\n`);
    }
    return 0;
  }

  if (options.command === "set-key") {
    const key = options.args[0] || options.key;
    if (!key) {
      process.stderr.write("cursor-api set-key requires a Cursor API key.\n");
      return 1;
    }
    const saved = await saveApiKey(key, options.config);
    process.stdout.write(`Saved Cursor API key to ${saved}\n`);
    return 0;
  }

  if (options.command === "setup") {
    const target = (options.args[0] || "all").toLowerCase();
    if (target === "all") {
      for (const result of await setupAll(config)) {
        process.stdout.write(`${result.id}: ${result.detail} (${result.configPath})\n`);
      }
      return 0;
    }
    if (!isSetupAgent(target)) {
      process.stderr.write(`Unknown agent '${target}'. Use: ${SETUP_AGENTS.join(", ")}, or all.\n`);
      return 1;
    }
    const result = await setupAgent(target, config);
    process.stdout.write(`${result.id}: ${result.detail} (${result.configPath})\n`);
    return 0;
  }

  if (options.command === "install-service") {
    const result = await installUserService({
      execPath: process.execPath,
      scriptPath: cliScriptPath(),
      extraArgs: options.config ? ["--config", options.config] : []
    });
    process.stdout.write(`${result.detail}\n`);
    return result.enabled ? 0 : 1;
  }

  if (options.command === "uninstall-service") {
    const result = await uninstallUserService();
    process.stdout.write(`${result.detail}\n`);
    return 0;
  }

  if (options.command !== "serve") {
    process.stderr.write(`Unknown command '${options.command}'.\n\n${HELP}`);
    return 1;
  }

  if (!config.cursorApiKey) {
    process.stderr.write(
      "No Cursor API key configured. Set CURSOR_API_KEY, pass --key, or run `cursor-api set-key <key>`.\n"
    );
    return 1;
  }

  await serve(config);
  return 0;
}

async function serve(config: AppConfig): Promise<void> {
  const bridgePort = await findFreePort(config.host, 8792);
  const bridgeToken = crypto.randomUUID().replaceAll("-", "");
  process.env.CURSOR_SDK_BRIDGE_HOST = config.host;
  process.env.CURSOR_SDK_BRIDGE_PORT = String(bridgePort);
  process.env.CURSOR_SDK_BRIDGE_TOKEN = bridgeToken;
  const { startServer } = await import("./bridge.mjs");
  startServer();
  await waitForHealth(`http://${config.host}:${bridgePort}/health`);

  const ctx = createContext(config, {
    url: `http://${config.host}:${bridgePort}/sdk`,
    token: bridgeToken
  });
  const origin = `http://${config.host}:${config.port}`;
  const server = createServer((req, res) => {
    incomingToRequest(req, origin)
      .then((request) => handleRequest(request, ctx))
      .then((response) => writeNodeResponse(res, response))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Internal error";
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message } }));
          return;
        }
        // SSE headers already went out. Appending JSON would corrupt the stream.
        res.end();
      });
  });
  // Streaming Cursor turns can exceed Node's 300s requestTimeout.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });

  process.stdout.write(`${DISPLAY_NAME} listening on ${baseUrl(config)}\n`);
  process.stdout.write(`Health: http://${config.host}:${config.port}/health\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = { command: "serve", args: [] };
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift() as string;
  }
  while (args.length) {
    const arg = args.shift() as string;
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else if (arg === "--host") {
      options.host = args.shift();
    } else if (arg === "--port" || arg === "-p") {
      options.port = Number.parseInt(args.shift() || "", 10);
    } else if (arg === "--key") {
      options.key = args.shift();
    } else if (arg === "--config") {
      options.config = args.shift();
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      options.args.push(arg);
    }
  }
  return options;
}

function isSetupAgent(value: string): value is SetupAgent {
  return (SETUP_AGENTS as readonly string[]).includes(value);
}

function cliScriptPath(): string {
  if (!process.argv[1]) {
    throw new Error("Cannot resolve the cursor-api script path.");
  }
  return realpathSync(process.argv[1]);
}

async function findFreePort(host: string, start: number): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    if (!(await portIsOpen(host, port))) return port;
  }
  throw new Error("Could not find a free port for the Cursor SDK bridge.");
}

function portIsOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Bridge is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Cursor SDK bridge did not become ready.");
}

// Resolve symlinks so this still matches when run through a linked bin (e.g. `bun link` / `npm link`).
const argvPath = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
const isMain = argvPath && pathToFileURL(argvPath).href === import.meta.url;
if (isMain) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  );
}
