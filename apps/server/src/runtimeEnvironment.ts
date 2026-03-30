import { spawnSync } from "node:child_process";
import os from "node:os";

import type {
  ServerExecutionEnvironment,
  ServerHostOsFamily,
  ServerHostRuntime,
} from "@t3tools/contracts";

interface DetectServerRuntimeEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly osRelease?: string;
  readonly listWindowsWslDistros?: () => ReadonlyArray<string>;
}

interface ServerRuntimeEnvironmentDetails {
  readonly hostRuntime: ServerHostRuntime;
  readonly availableExecutionEnvironments: ReadonlyArray<ServerExecutionEnvironment>;
}

let cachedWindowsWslDistros: ReadonlyArray<string> | null = null;
let cachedServerRuntimeEnvironment: ServerRuntimeEnvironmentDetails | null = null;

function normalizeOsFamily(platform: NodeJS.Platform): ServerHostOsFamily {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : null;
}

function isWslHost(params: {
  readonly osFamily: ServerHostOsFamily;
  readonly env: NodeJS.ProcessEnv;
  readonly osRelease: string;
}): boolean {
  if (params.osFamily !== "linux") {
    return false;
  }

  return (
    readEnvValue(params.env, "WSL_DISTRO_NAME") !== null ||
    readEnvValue(params.env, "WSL_INTEROP") !== null ||
    params.osRelease.toLowerCase().includes("microsoft")
  );
}

function parseWslDistroList(stdout: string): ReadonlyArray<string> {
  const distros = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const normalized = line
      .replaceAll("\u0000", "")
      .replace(/^\uFEFF/u, "")
      .trim();
    if (normalized.length === 0) continue;
    distros.add(normalized);
  }
  return Array.from(distros);
}

function listInstalledWindowsWslDistros(): ReadonlyArray<string> {
  const result = spawnSync("wsl.exe", ["-l", "-q"], {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }

  return parseWslDistroList(result.stdout);
}

function listInstalledWindowsWslDistrosCached(): ReadonlyArray<string> {
  if (cachedWindowsWslDistros !== null) {
    return cachedWindowsWslDistros;
  }

  cachedWindowsWslDistros = listInstalledWindowsWslDistros();
  return cachedWindowsWslDistros;
}

function resolveAvailableExecutionEnvironments(params: {
  readonly hostRuntime: ServerHostRuntime;
  readonly listWindowsWslDistros: () => ReadonlyArray<string>;
}): ReadonlyArray<ServerExecutionEnvironment> {
  const environments: ServerExecutionEnvironment[] = [{ kind: "host" }];
  if (params.hostRuntime.osFamily !== "windows") {
    return environments;
  }

  for (const distroName of params.listWindowsWslDistros()) {
    environments.push({
      kind: "wsl",
      distroName,
    });
  }

  return environments;
}

export function detectServerRuntimeEnvironment(
  options: DetectServerRuntimeEnvironmentOptions = {},
): ServerRuntimeEnvironmentDetails {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const osRelease = options.osRelease ?? os.release();
  const osFamily = normalizeOsFamily(platform);
  const isWsl = isWslHost({ osFamily, env, osRelease });
  const hostRuntime: ServerHostRuntime = {
    rawPlatform: platform,
    osFamily,
    pathStyle: platform === "win32" ? "windows" : "posix",
    isWsl,
    wslDistroName: isWsl ? readEnvValue(env, "WSL_DISTRO_NAME") : null,
  };

  return {
    hostRuntime,
    availableExecutionEnvironments: resolveAvailableExecutionEnvironments({
      hostRuntime,
      listWindowsWslDistros: options.listWindowsWslDistros ?? listInstalledWindowsWslDistrosCached,
    }),
  };
}

export function getServerRuntimeEnvironment(): ServerRuntimeEnvironmentDetails {
  if (cachedServerRuntimeEnvironment !== null) {
    return cachedServerRuntimeEnvironment;
  }

  cachedServerRuntimeEnvironment = detectServerRuntimeEnvironment();
  return cachedServerRuntimeEnvironment;
}

export function resetServerRuntimeEnvironmentCacheForTests(): void {
  cachedWindowsWslDistros = null;
  cachedServerRuntimeEnvironment = null;
}
