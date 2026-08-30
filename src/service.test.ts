import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installUserService,
  renderUserServiceUnit,
  SERVICE_UNIT,
  systemdQuote,
  restartUserService,
  uninstallUserService,
  userServiceStatus,
  userUnitPath,
  type CommandResult
} from "./service.js";

function envFor(home: string): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: path.join(home, ".config") };
}

function recordingRun(calls: string[][], results: CommandResult[] = []): (command: string, args: string[]) => Promise<CommandResult> {
  return async (command, args) => {
    calls.push([command, ...args]);
    return results.shift() ?? { code: 0, stdout: "", stderr: "" };
  };
}

describe("user service", () => {
  it("quotes systemd ExecStart arguments that need it", () => {
    expect(systemdQuote("/usr/bin/node")).toBe("/usr/bin/node");
    expect(systemdQuote("/opt/API for Cursor/cli.js")).toBe('"/opt/API for Cursor/cli.js"');
  });

  it("renders a user unit that runs serve", () => {
    const unit = renderUserServiceUnit("/usr/bin/node", "/opt/cursor-api/dist/cli.js", ["--config", "/tmp/config.json"]);
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/cursor-api/dist/cli.js serve --config /tmp/config.json");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("writes the unit and enables it with systemctl --user", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const calls: string[][] = [];
    const result = await installUserService({
      home,
      env,
      execPath: "/usr/bin/node",
      scriptPath: "/opt/cursor-api/dist/cli.js",
      run: recordingRun(calls)
    });

    expect(result.enabled).toBe(true);
    expect(result.unitPath).toBe(userUnitPath(env, home));
    const text = await readFile(result.unitPath, "utf8");
    expect(text).toContain("ExecStart=/usr/bin/node /opt/cursor-api/dist/cli.js serve");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", SERVICE_UNIT]
    ]);
  });

  it("still writes the unit if systemctl enable fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const result = await installUserService({
      home,
      env,
      execPath: "/usr/bin/node",
      scriptPath: "/opt/cursor-api/dist/cli.js",
      run: recordingRun(
        [],
        [
          { code: 0, stdout: "", stderr: "" },
          { code: 1, stdout: "", stderr: "Failed to connect to bus" }
        ]
      )
    });

    expect(result.enabled).toBe(false);
    expect(await readFile(result.unitPath, "utf8")).toContain("ExecStart=");
    expect(result.detail).toContain("Failed to connect to bus");
  });

  it("skips systemctl when start is false", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const calls: string[][] = [];
    const result = await installUserService({
      home,
      env,
      execPath: "/usr/bin/node",
      scriptPath: "/opt/cursor-api/dist/cli.js",
      start: false,
      run: recordingRun(calls)
    });
    expect(result.enabled).toBe(false);
    expect(calls).toEqual([]);
    expect(result.detail).toContain("systemctl --user enable --now");
  });

  it("disables the unit and deletes the file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const unitPath = userUnitPath(env, home);
    await installUserService({
      home,
      env,
      execPath: "/usr/bin/node",
      scriptPath: "/opt/cursor-api/dist/cli.js",
      start: false
    });

    const calls: string[][] = [];
    const result = await uninstallUserService({
      home,
      env,
      run: recordingRun(calls)
    });
    expect(result.detail).toContain("Stopped and removed");
    expect(calls).toEqual([
      ["systemctl", "--user", "disable", "--now", SERVICE_UNIT],
      ["systemctl", "--user", "daemon-reload"]
    ]);
    await expect(readFile(unitPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts the unit with systemctl --user", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const calls: string[][] = [];
    const result = await restartUserService({
      home,
      env,
      run: recordingRun(calls)
    });
    expect(result.restarted).toBe(true);
    expect(result.detail).toContain("Restarted");
    expect(calls).toEqual([["systemctl", "--user", "restart", SERVICE_UNIT]]);
  });

  it("reports restart failure", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const result = await restartUserService({
      home,
      env,
      run: recordingRun([], [{ code: 1, stdout: "", stderr: "Unit not found" }])
    });
    expect(result.restarted).toBe(false);
    expect(result.detail).toContain("Unit not found");
  });

  it("reports systemctl --user status output", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-api-service-"));
    const env = envFor(home);
    const calls: string[][] = [];
    const result = await userServiceStatus({
      home,
      env,
      run: recordingRun(calls, [
        { code: 0, stdout: "Active: active (running)", stderr: "" },
        { code: 0, stdout: "enabled", stderr: "" }
      ])
    });
    expect(result.active).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.detail).toContain("Active: active (running)");
    expect(calls).toEqual([
      ["systemctl", "--user", "status", "--no-pager", SERVICE_UNIT],
      ["systemctl", "--user", "is-enabled", SERVICE_UNIT]
    ]);
  });
});
