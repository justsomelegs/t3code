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
      cwd: undefined,
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
      expect(plan.cwd).toBeUndefined();
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
      expect(plan.cwd).toBeUndefined();
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
      cwd: undefined,
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

  it("wraps WSL execution through wsl.exe with translated cwd", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-process-plan-wsl-"));
    const wslPath = path.join(tempDir, "wsl.exe");
    fs.writeFileSync(wslPath, "");

    try {
      const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
        platform: "win32",
        cwd: "C:\\Users\\mike\\repo",
        env: {
          PATH: tempDir,
          PATHEXT: ".EXE;.CMD",
        },
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
      });

      expect(plan.command.toLowerCase()).toBe(wslPath.toLowerCase());
      expect(plan.args).toEqual([
        "--distribution",
        "Ubuntu-24.04",
        "--cd",
        "/mnt/c/Users/mike/repo",
        "--exec",
        "codex",
        "app-server",
      ]);
      expect(plan.shell).toBe(false);
      expect(plan.cwd).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("infers distro from WSL UNC workspace paths", () => {
    const plan = resolveProcessLaunchPlan("codex", ["app-server"], {
      platform: "win32",
      cwd: "\\\\wsl$\\Arch\\home\\mike\\repo",
      hostRuntime: {
        rawPlatform: "win32",
        osFamily: "windows",
        pathStyle: "windows",
        isWsl: false,
        wslDistroName: null,
      },
      executionEnvironment: {
        kind: "wsl",
        distroName: null,
      },
    });

    expect(plan.command.toLowerCase()).toMatch(/wsl\.exe$/);
    expect(plan.args).toEqual([
      "--distribution",
      "Arch",
      "--cd",
      "/home/mike/repo",
      "--exec",
      "codex",
      "app-server",
    ]);
    expect(plan.shell).toBe(false);
    expect(plan.cwd).toBeUndefined();
  });

  it("rejects Windows command paths for WSL execution", () => {
    expect(() =>
      resolveProcessLaunchPlan("C:\\tools\\codex.exe", ["app-server"], {
        platform: "win32",
        cwd: "C:\\Users\\mike\\repo",
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
    ).toThrow("WSL execution requires a Linux command path or PATH command");
  });
});
