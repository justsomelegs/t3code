import os from "node:os";

import type { ServerRuntimeEnvironment, ServerRuntimePlatform } from "@t3tools/contracts";

interface DetectServerRuntimeEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly osRelease?: string;
}

function normalizePlatform(platform: NodeJS.Platform): ServerRuntimePlatform {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : null;
}

function isWslHost(params: {
  readonly normalizedPlatform: ServerRuntimePlatform;
  readonly env: NodeJS.ProcessEnv;
  readonly osRelease: string;
}): boolean {
  if (params.normalizedPlatform !== "linux") {
    return false;
  }

  return (
    readEnvValue(params.env, "WSL_DISTRO_NAME") !== null ||
    readEnvValue(params.env, "WSL_INTEROP") !== null ||
    params.osRelease.toLowerCase().includes("microsoft")
  );
}

export function detectServerRuntimeEnvironment(
  options: DetectServerRuntimeEnvironmentOptions = {},
): ServerRuntimeEnvironment {
  const env = options.env ?? process.env;
  const normalizedPlatform = normalizePlatform(options.platform ?? process.platform);
  const osRelease = options.osRelease ?? os.release();
  const isWsl = isWslHost({ normalizedPlatform, env, osRelease });

  return {
    platform: normalizedPlatform,
    pathStyle: normalizedPlatform === "windows" ? "windows" : "posix",
    isWsl,
    windowsInteropMode:
      normalizedPlatform === "windows" ? "windows-native" : isWsl ? "wsl-hosted" : null,
    wslDistroName: isWsl ? readEnvValue(env, "WSL_DISTRO_NAME") : null,
  };
}
