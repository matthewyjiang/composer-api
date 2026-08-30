import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configHome, DISPLAY_NAME } from "./config.js";

export const SERVICE_UNIT = "cursor-api.service";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ServiceCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  scriptPath?: string;
  extraArgs?: string[];
  run?: CommandRunner;
  start?: boolean;
}

export interface ServiceInstallResult {
  unitPath: string;
  enabled: boolean;
  detail: string;
}

export interface ServiceStatusResult {
  unitPath: string;
  active: boolean;
  enabled: boolean;
  detail: string;
}

function userUnitDir(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(configHome(env, home), "systemd", "user");
}

export function userUnitPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(userUnitDir(env, home), SERVICE_UNIT);
}

export function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderUserServiceUnit(execPath: string, scriptPath: string, extraArgs: string[] = []): string {
  const command = [execPath, scriptPath, "serve", ...extraArgs].map(systemdQuote).join(" ");
  return `[Unit]
Description=${DISPLAY_NAME}
After=network.target

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export async function installUserService(options: ServiceCommandOptions = {}): Promise<ServiceInstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;
  const scriptPath = options.scriptPath;
  if (!scriptPath) {
    throw new Error("Cannot resolve the cursor-api script path.");
  }

  const unitPath = userUnitPath(env, home);
  await mkdir(path.dirname(unitPath), { recursive: true });
  await writeFile(unitPath, renderUserServiceUnit(execPath, scriptPath, options.extraArgs ?? []), "utf8");

  if (options.start === false) {
    return {
      unitPath,
      enabled: false,
      detail: `Wrote ${unitPath}. Enable with: systemctl --user enable --now ${SERVICE_UNIT}`
    };
  }

  const run = options.run ?? runCommand;
  const reload = await runSystemctl(run, ["daemon-reload"]);
  if (reload.code !== 0) {
    return {
      unitPath,
      enabled: false,
      detail: systemctlFailure("Wrote the unit file but `systemctl --user daemon-reload` failed", reload, unitPath)
    };
  }

  const enable = await runSystemctl(run, ["enable", "--now", SERVICE_UNIT]);
  if (enable.code !== 0) {
    return {
      unitPath,
      enabled: false,
      detail: systemctlFailure("Wrote the unit file but could not enable the user service", enable, unitPath)
    };
  }

  return {
    unitPath,
    enabled: true,
    detail: `Installed and started ${SERVICE_UNIT} (${unitPath})`
  };
}

export async function uninstallUserService(options: ServiceCommandOptions = {}): Promise<ServiceInstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const unitPath = userUnitPath(env, home);
  const run = options.run ?? runCommand;

  const disable = await runSystemctl(run, ["disable", "--now", SERVICE_UNIT]);
  await unlink(unitPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const reload = await runSystemctl(run, ["daemon-reload"]);

  if (disable.code !== 0 && !isMissingUnit(disable)) {
    return {
      unitPath,
      enabled: false,
      detail: systemctlFailure("Removed the unit file but `systemctl --user disable --now` failed", disable, unitPath)
    };
  }
  if (reload.code !== 0) {
    return {
      unitPath,
      enabled: false,
      detail: systemctlFailure("Removed the unit file but `systemctl --user daemon-reload` failed", reload, unitPath)
    };
  }

  return {
    unitPath,
    enabled: false,
    detail: `Stopped and removed ${SERVICE_UNIT}`
  };
}

export async function userServiceStatus(options: ServiceCommandOptions = {}): Promise<ServiceStatusResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const unitPath = userUnitPath(env, home);
  const run = options.run ?? runCommand;
  const status = await runSystemctl(run, ["status", "--no-pager", SERVICE_UNIT]);
  const enabledCheck = await runSystemctl(run, ["is-enabled", SERVICE_UNIT]);
  const detail =
    [status.stdout, status.stderr].map((part) => part.trim()).filter(Boolean).join("\n") ||
    `systemctl --user status ${SERVICE_UNIT} exited ${status.code}`;
  return {
    unitPath,
    active: status.code === 0,
    enabled: enabledCheck.code === 0,
    detail
  };
}

function runSystemctl(run: CommandRunner, args: string[]): Promise<CommandResult> {
  return run("systemctl", ["--user", ...args]).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "systemctl not found" };
    }
    throw error;
  });
}

function systemctlFailure(prefix: string, result: CommandResult, unitPath: string): string {
  const stderr = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return `${prefix}: ${stderr}\nUnit file: ${unitPath}\nEnable later with: systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_UNIT}`;
}

function isMissingUnit(result: CommandResult): boolean {
  return /not (loaded|found)|does not exist/i.test(`${result.stdout}\n${result.stderr}`);
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
