import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveProcessLaunchPlan, runProcess } from "./processRunner";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });
});

describe("resolveProcessLaunchPlan", () => {
  it("returns direct spawn without shell on non-Windows hosts", () => {
    const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
      platform: "linux",
    });

    expect(plan).toEqual({
      command: "codex",
      args: ["app-server"],
      shell: false,
    });
  });

  it("resolves native Windows executables without using a shell", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-process-plan-native-"));
    const exePath = path.join(tempDir, "codex.exe");
    fs.writeFileSync(exePath, "");

    try {
      const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
        platform: "win32",
        env: {
          PATH: tempDir,
          PATHEXT: ".EXE;.CMD",
        },
      });

      expect(plan.args).toEqual(["app-server"]);
      expect(plan.shell).toBe(false);
      expect(plan.command.toLowerCase()).toBe(exePath.toLowerCase());
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves Windows batch launchers through cmd.exe", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-process-plan-batch-"));
    const cmdPath = path.join(tempDir, "codex.cmd");
    fs.writeFileSync(cmdPath, "@echo off\r\n");

    try {
      const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
        platform: "win32",
        env: {
          PATH: tempDir,
          PATHEXT: ".CMD;.EXE",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
      });

      expect(plan.args).toEqual(["app-server"]);
      expect(plan.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(plan.command.toLowerCase()).toBe(cmdPath.toLowerCase());
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to direct spawn when a Windows command cannot be resolved", () => {
    const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
      platform: "win32",
      env: {
        PATH: "",
        PATHEXT: ".EXE;.CMD",
      },
    });

    expect(plan).toEqual({
      command: "codex",
      args: ["app-server"],
      shell: false,
    });
  });

  it("fails clearly when WSL execution is requested on a non-Windows host", () => {
    expect(() =>
      resolveProcessLaunchPlan("codex", ["app-server"], {
        platform: "linux",
        hostRuntime: {
          rawPlatform: "linux",
          osFamily: "linux",
          pathStyle: "posix",
          isWsl: false,
          wslDistroName: null,
        },
        executionEnvironment: {
          kind: "wsl",
          distroName: "Ubuntu-24.04",
        },
      }),
    ).toThrow("WSL execution requires a Windows host.");
  });

  it("fails clearly when WSL execution is requested before transport support exists", () => {
    expect(() =>
      resolveProcessLaunchPlan("codex", ["app-server"], {
        platform: "win32",
        hostRuntime: {
          rawPlatform: "win32",
          osFamily: "windows",
          pathStyle: "windows",
          isWsl: false,
          wslDistroName: null,
        },
        executionEnvironment: {
          kind: "wsl",
          distroName: "Ubuntu-24.04",
        },
      }),
    ).toThrow("WSL execution launch planning is not implemented yet.");
  });
});
