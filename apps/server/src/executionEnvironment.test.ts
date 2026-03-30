import { describe, expect, it } from "vitest";

import {
  inferExecutionEnvironmentFromCwd,
  resolveExecutionEnvironment,
} from "./executionEnvironment";

describe("resolveExecutionEnvironment", () => {
  const windowsHostRuntime = {
    rawPlatform: "win32",
    osFamily: "windows" as const,
    pathStyle: "windows" as const,
    isWsl: false,
    wslDistroName: null,
  };

  const linuxHostRuntime = {
    rawPlatform: "linux",
    osFamily: "linux" as const,
    pathStyle: "posix" as const,
    isWsl: false,
    wslDistroName: null,
  };

  const availableExecutionEnvironments = [
    { kind: "host" as const },
    { kind: "wsl" as const, distroName: "Ubuntu-24.04" },
    { kind: "wsl" as const, distroName: "Arch" },
  ];

  it("defaults to the host environment", () => {
    expect(
      resolveExecutionEnvironment({
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
      }),
    ).toEqual({ kind: "host" });
  });

  it("returns the host environment when explicitly requested", () => {
    expect(
      resolveExecutionEnvironment({
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
        preference: { kind: "host" },
      }),
    ).toEqual({ kind: "host" });
  });

  it("resolves an explicitly requested WSL distribution", () => {
    expect(
      resolveExecutionEnvironment({
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
        preference: { kind: "wsl", distroName: "Arch" },
      }),
    ).toEqual({ kind: "wsl", distroName: "Arch" });
  });

  it("defaults to the first available WSL distribution when none is specified", () => {
    expect(
      resolveExecutionEnvironment({
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
        preference: { kind: "wsl", distroName: null },
      }),
    ).toEqual({ kind: "wsl", distroName: "Ubuntu-24.04" });
  });

  it("fails clearly when WSL execution is requested on a non-Windows host", () => {
    expect(() =>
      resolveExecutionEnvironment({
        hostRuntime: linuxHostRuntime,
        availableExecutionEnvironments: [{ kind: "host" }],
        preference: { kind: "wsl", distroName: "Ubuntu-24.04" },
      }),
    ).toThrow("WSL execution requires a Windows host.");
  });

  it("fails clearly when the requested WSL distribution is unavailable", () => {
    expect(() =>
      resolveExecutionEnvironment({
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments: [{ kind: "host" }],
        preference: { kind: "wsl", distroName: "Ubuntu-24.04" },
      }),
    ).toThrow("WSL execution was requested, but no WSL distributions are available.");
  });
});

describe("inferExecutionEnvironmentFromCwd", () => {
  const windowsHostRuntime = {
    rawPlatform: "win32",
    osFamily: "windows" as const,
    pathStyle: "windows" as const,
    isWsl: false,
    wslDistroName: null,
  };

  const availableExecutionEnvironments = [
    { kind: "host" as const },
    { kind: "wsl" as const, distroName: "Ubuntu-24.04" },
    { kind: "wsl" as const, distroName: "Arch" },
  ];

  it("infers WSL execution from UNC WSL workspace paths", () => {
    expect(
      inferExecutionEnvironmentFromCwd({
        cwd: "\\\\wsl$\\Arch\\home\\mike\\repo",
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
      }),
    ).toEqual({
      kind: "wsl",
      distroName: "Arch",
    });
  });

  it("infers default-distro WSL execution from POSIX workspace paths on Windows", () => {
    expect(
      inferExecutionEnvironmentFromCwd({
        cwd: "/home/mike/repo",
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
      }),
    ).toEqual({
      kind: "wsl",
      distroName: "Ubuntu-24.04",
    });
  });

  it("keeps Windows drive workspace paths on the host", () => {
    expect(
      inferExecutionEnvironmentFromCwd({
        cwd: "C:\\Users\\mike\\repo",
        hostRuntime: windowsHostRuntime,
        availableExecutionEnvironments,
      }),
    ).toEqual({
      kind: "host",
    });
  });
});
