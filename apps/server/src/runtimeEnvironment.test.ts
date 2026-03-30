import { describe, expect, it } from "vitest";

import { detectServerRuntimeEnvironment } from "./runtimeEnvironment";

describe("detectServerRuntimeEnvironment", () => {
  it("detects native Windows hosts", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "win32",
        env: {},
        osRelease: "10.0.22631",
      }),
    ).toEqual({
      platform: "windows",
      pathStyle: "windows",
      isWsl: false,
      windowsInteropMode: "windows-native",
      wslDistroName: null,
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
      platform: "linux",
      pathStyle: "posix",
      isWsl: false,
      windowsInteropMode: null,
      wslDistroName: null,
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
      platform: "linux",
      pathStyle: "posix",
      isWsl: true,
      windowsInteropMode: "wsl-hosted",
      wslDistroName: "Ubuntu-24.04",
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
      platform: "macos",
      pathStyle: "posix",
      isWsl: false,
      windowsInteropMode: null,
      wslDistroName: null,
    });
  });
});
