import { spawnSync } from "node:child_process";

import { Effect, Layer } from "effect";

import { detectServerRuntimeEnvironment, parseWslDistroList } from "../../runtimeEnvironment";
import { RuntimeEnvironment, type RuntimeEnvironmentShape } from "../Services/RuntimeEnvironment";

const WSL_DISTRO_LIST_TIMEOUT_MS = 1_500;

function listInstalledWindowsWslDistros(): ReadonlyArray<string> {
  try {
    const result = spawnSync("wsl.exe", ["-l", "-q"], {
      encoding: "utf8",
      timeout: WSL_DISTRO_LIST_TIMEOUT_MS,
      windowsHide: true,
    });

    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }

    return parseWslDistroList(result.stdout);
  } catch {
    return [];
  }
}

const makeRuntimeEnvironment = Effect.sync(() => {
  const details = detectServerRuntimeEnvironment({
    listWindowsWslDistros: listInstalledWindowsWslDistros,
  });

  return {
    getRuntimeEnvironment: Effect.succeed(details),
    getHostRuntime: Effect.succeed(details.hostRuntime),
    getAvailableExecutionEnvironments: Effect.succeed(details.availableExecutionEnvironments),
  } satisfies RuntimeEnvironmentShape;
});

export const RuntimeEnvironmentLive = Layer.effect(RuntimeEnvironment, makeRuntimeEnvironment);
