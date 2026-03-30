import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  RuntimeEnvironmentProbeError,
  resolveRuntimeEnvironmentDetails,
} from "./RuntimeEnvironment";

describe("resolveRuntimeEnvironmentDetails", () => {
  it("includes WSL execution environments when the Windows probe succeeds", async () => {
    const details = await Effect.runPromise(
      resolveRuntimeEnvironmentDetails({
        detectOptions: {
          platform: "win32",
          env: {},
          osRelease: "10.0.22631",
        },
        probeWindowsWslDistros: Effect.succeed(["Ubuntu-24.04", "Arch"]),
      }),
    );

    expect(details).toEqual({
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

  it("does not fail server runtime resolution when WSL is unavailable", async () => {
    const details = await Effect.runPromise(
      resolveRuntimeEnvironmentDetails({
        detectOptions: {
          platform: "win32",
          env: {},
          osRelease: "10.0.22631",
        },
        probeWindowsWslDistros: Effect.fail(
          new RuntimeEnvironmentProbeError({
            operation: "probeWindowsWslDistros",
            reason: "command-unavailable",
            message: "wsl.exe not found",
          }),
        ),
      }),
    );

    expect(details.availableExecutionEnvironments).toEqual([{ kind: "host" }]);
  });

  it("does not probe WSL on non-Windows hosts", async () => {
    let wasProbed = false;

    const details = await Effect.runPromise(
      resolveRuntimeEnvironmentDetails({
        detectOptions: {
          platform: "linux",
          env: {},
          osRelease: "6.8.0-generic",
        },
        probeWindowsWslDistros: Effect.sync(() => {
          wasProbed = true;
          return ["Ubuntu-24.04"];
        }),
      }),
    );

    expect(wasProbed).toBe(false);
    expect(details.availableExecutionEnvironments).toEqual([{ kind: "host" }]);
  });
});
