import { describe, expect, it } from "vitest";

import { detectServerRuntimeEnvironment } from "./runtimeEnvironment";

describe("detectServerRuntimeEnvironment", () => {
  it("detects native Windows hosts and advertised WSL distros", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "win32",
        env: {},
        osRelease: "10.0.22631",
        listWindowsWslDistros: () => ["Ubuntu-24.04", "Arch"],
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "win32",
        osFamily: "windows",
        pathStyle: "windows",
        isWsl: false,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [
        { kind: "host" },
        { kind: "wsl", distroName: "Ubuntu-24.04" },
        { kind: "wsl", distroName: "Arch" },
      ],
    });
  });

  it("detects native Linux hosts", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {},
        osRelease: "6.8.0-generic",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "linux",
        osFamily: "linux",
        pathStyle: "posix",
        isWsl: false,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });

  it("detects WSL hosts from distro metadata", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {
          WSL_DISTRO_NAME: "Ubuntu-24.04",
        },
        osRelease: "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "linux",
        osFamily: "linux",
        pathStyle: "posix",
        isWsl: true,
        wslDistroName: "Ubuntu-24.04",
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });

  it("detects WSL hosts from WSL_INTEROP without distro name", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {
          WSL_INTEROP: "/run/WSL/1_interop",
        },
        osRelease: "6.8.0-generic",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "linux",
        osFamily: "linux",
        pathStyle: "posix",
        isWsl: true,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });

  it("detects WSL hosts from kernel release metadata alone", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {},
        osRelease: "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "linux",
        osFamily: "linux",
        pathStyle: "posix",
        isWsl: true,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });

  it("treats non-linux hosts with WSL env vars as non-WSL", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "darwin",
        env: {
          WSL_DISTRO_NAME: "Ubuntu-24.04",
          WSL_INTEROP: "/run/WSL/1_interop",
        },
        osRelease: "24.5.0",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "darwin",
        osFamily: "macos",
        pathStyle: "posix",
        isWsl: false,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });

  it("normalizes unsupported platforms to other instead of linux", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "freebsd",
        env: {},
        osRelease: "14.2-RELEASE",
      }),
    ).toEqual({
      hostRuntime: {
        rawPlatform: "freebsd",
        osFamily: "other",
        pathStyle: "posix",
        isWsl: false,
        wslDistroName: null,
      },
      availableExecutionEnvironments: [{ kind: "host" }],
    });
  });
});
