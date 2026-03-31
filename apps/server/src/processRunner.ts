import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";
import { extname, join } from "node:path";

import { ChildProcess } from "effect/unstable/process";
import type { ServerExecutionEnvironment, ServerHostRuntime } from "@t3tools/contracts";

import {
  resolveCommandCandidates,
  resolveExecutableFile,
  resolvePathEnvironmentVariable,
  resolveWindowsPathExtensions,
  stripWrappingQuotes,
} from "./commandResolution";
import { resolveWslCommand, resolveWslWorkingDirectory } from "./pathInterop";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
  shell?: boolean | string | undefined;
  hostRuntime?: ServerHostRuntime | undefined;
  executionEnvironment?: ServerExecutionEnvironment | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

interface ProcessLaunchPlanOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  shell?: boolean | string | undefined;
  platform?: NodeJS.Platform | undefined;
  hostRuntime?: ServerHostRuntime | undefined;
  executionEnvironment?: ServerExecutionEnvironment | undefined;
}

export interface ProcessLaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean | string;
  readonly cwd?: string | undefined;
}

interface ResolvedWindowsCommand {
  readonly path: string;
  readonly kind: "native" | "batch";
}

const WINDOWS_BATCH_EXECUTABLE_EXTENSIONS = new Set([".CMD", ".BAT"]);

function normalizeHostOsFamily(platform: NodeJS.Platform): ServerHostRuntime["osFamily"] {
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

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return /is not recognized as an internal or external command/i.test(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function resolveEffectiveEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
  };
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): ResolvedWindowsCommand | null {
  const windowsPathExtensions = resolveWindowsPathExtensions(env);
  const candidates = resolveCommandCandidates(command, "win32", windowsPathExtensions);

  const classify = (filePath: string): ResolvedWindowsCommand => {
    const extension = extname(filePath).toUpperCase();
    return {
      path: filePath,
      kind: WINDOWS_BATCH_EXECUTABLE_EXTENSIONS.has(extension) ? "batch" : "native",
    };
  };

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of candidates) {
      const resolvedCandidate = resolveExecutableFile(candidate, {
        platform: "win32",
        windowsPathExtensions,
        cwd,
      });
      if (resolvedCandidate) {
        return classify(resolvedCandidate);
      }
    }
    return null;
  }

  const pathEntries = resolvePathEnvironmentVariable(env)
    .split(";")
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of candidates) {
      const candidatePath = join(pathEntry, candidate);
      if (
        resolveExecutableFile(candidatePath, {
          platform: "win32",
          windowsPathExtensions,
        })
      ) {
        return classify(candidatePath);
      }
    }
  }

  return null;
}

function resolveWindowsCommandShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
}

function resolveWindowsExecutableCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string {
  const resolved = resolveWindowsCommand(command, env, cwd);
  if (resolved) {
    return resolved.path;
  }

  return command;
}

function resolveHostSpawnCwd(options: ProcessLaunchPlanOptions): string | undefined {
  if (options.executionEnvironment?.kind === "wsl") {
    return undefined;
  }

  return options.cwd;
}

function resolveWslProcessLaunchPlan(
  command: string,
  args: ReadonlyArray<string>,
  options: ProcessLaunchPlanOptions,
): ProcessLaunchPlan {
  const executionEnvironment = options.executionEnvironment;
  if (!executionEnvironment || executionEnvironment.kind !== "wsl") {
    throw new Error("WSL launch planning requires a WSL execution environment.");
  }

  const env = resolveEffectiveEnvironment(options.env);
  const wslExecutable = resolveWindowsExecutableCommand("wsl.exe", env, options.cwd);
  const { distroName, cwd } = resolveWslWorkingDirectory({
    cwd: options.cwd,
    executionEnvironment,
  });

  return {
    command: wslExecutable,
    args: [
      ...(distroName ? ["--distribution", distroName] : []),
      ...(cwd ? ["--cd", cwd] : []),
      "--exec",
      resolveWslCommand(command),
      ...args,
    ],
    shell: false,
    cwd: undefined,
  };
}

function assertSupportedExecutionEnvironment(options: ProcessLaunchPlanOptions): void {
  const executionEnvironment = options.executionEnvironment;
  if (!executionEnvironment || executionEnvironment.kind === "host") {
    return;
  }

  const hostOsFamily =
    options.hostRuntime?.osFamily ??
    normalizeHostOsFamily(options.platform ?? (process.platform as NodeJS.Platform));

  if (executionEnvironment.kind === "wsl" && hostOsFamily !== "windows") {
    throw new Error("WSL execution requires a Windows host.");
  }
}

export function resolveProcessLaunchPlan(
  command: string,
  args: ReadonlyArray<string>,
  options: ProcessLaunchPlanOptions = {},
): ProcessLaunchPlan {
  assertSupportedExecutionEnvironment(options);

  if (options.shell !== undefined) {
    return {
      command,
      args: [...args],
      shell: options.shell,
      cwd: resolveHostSpawnCwd(options),
    };
  }

  const platform = options.platform ?? process.platform;
  const executionEnvironment = options.executionEnvironment;

  if (executionEnvironment?.kind === "wsl") {
    return resolveWslProcessLaunchPlan(command, args, options);
  }

  if (platform !== "win32") {
    return {
      command,
      args: [...args],
      shell: false,
      cwd: resolveHostSpawnCwd(options),
    };
  }

  const env = resolveEffectiveEnvironment(options.env);
  const resolved = resolveWindowsCommand(command, env, options.cwd);
  if (!resolved) {
    return {
      command,
      args: [...args],
      shell: false,
      cwd: resolveHostSpawnCwd(options),
    };
  }

  if (resolved.kind === "batch") {
    // Node-installed Windows CLIs commonly ship as .cmd wrappers, so we still
    // need cmd.exe semantics after explicit command resolution.
    return {
      command: resolved.path,
      args: [...args],
      shell: resolveWindowsCommandShell(env),
      cwd: resolveHostSpawnCwd(options),
    };
  }

  return {
    command: resolved.path,
    args: [...args],
    shell: false,
    cwd: resolveHostSpawnCwd(options),
  };
}

export interface RuntimeCommandOptions extends ChildProcess.CommandOptions {
  hostRuntime?: ServerHostRuntime | undefined;
  executionEnvironment?: ServerExecutionEnvironment | undefined;
}

export function makeRuntimeCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: RuntimeCommandOptions = {},
): ChildProcess.StandardCommand {
  const { hostRuntime, executionEnvironment, ...childProcessOptions } = options;
  const launchPlan = resolveProcessLaunchPlan(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    hostRuntime,
    executionEnvironment,
  });
  return ChildProcess.make(launchPlan.command, launchPlan.args, {
    ...childProcessOptions,
    cwd: launchPlan.cwd,
    shell: launchPlan.shell,
  });
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill(signal);
}

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const launchPlan = resolveProcessLaunchPlan(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      hostRuntime: options.hostRuntime,
      executionEnvironment: options.executionEnvironment,
    });
    const child = spawn(launchPlan.command, launchPlan.args, {
      cwd: launchPlan.cwd,
      env: options.env,
      stdio: "pipe",
      shell: launchPlan.shell,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: Error): void => {
      killChild(child, "SIGTERM");
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const text = chunkBuffer.toString();
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunkBuffer, maxBufferBytes);
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stderr, stderrBytes, chunkBuffer, maxBufferBytes);
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += text;
        stderrBytes += byteLength;
        if (stderrBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stderr", maxBufferBytes);
        }
      }
      return null;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(normalizeSpawnError(command, args, error));
      });
    });

    child.once("close", (code, signal) => {
      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };

      finalize(() => {
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result));
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      fail(normalizeStdinError(command, args, error));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
