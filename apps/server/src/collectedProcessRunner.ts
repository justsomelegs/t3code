import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";

import { Data, Effect } from "effect";

export interface CollectedProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type CollectedProcessOutputMode = "error" | "truncate";
export type CollectedProcessCollectorMode = "concat" | "parts";

export interface CollectedProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly maxOutputBytes: number;
  readonly outputMode: CollectedProcessOutputMode;
  readonly truncatedMarker?: string;
  readonly shell?: boolean;
  readonly collectorMode?: CollectedProcessCollectorMode;
}

export class CollectedProcessSpawnError extends Data.TaggedError("CollectedProcessSpawnError")<{
  readonly cause: unknown;
}> {}

export class CollectedProcessStdinError extends Data.TaggedError("CollectedProcessStdinError")<{
  readonly cause: unknown;
}> {}

export class CollectedProcessOutputLimitError extends Data.TaggedError(
  "CollectedProcessOutputLimitError",
)<{
  readonly stream: "stdout" | "stderr";
  readonly maxBytes: number;
}> {}

export class CollectedProcessTimeoutError extends Data.TaggedError("CollectedProcessTimeoutError")<{
  readonly timeoutMs: number;
}> {}

export type CollectedProcessError =
  | CollectedProcessSpawnError
  | CollectedProcessStdinError
  | CollectedProcessOutputLimitError
  | CollectedProcessTimeoutError;

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
      // Fall back to direct kill if taskkill is unavailable.
    }
  }
  child.kill(signal);
}

interface OutputCollector {
  readonly append: (chunk: Buffer | string) => boolean;
  readonly finalize: () => {
    readonly text: string;
    readonly truncated: boolean;
  };
}

function makeConcatCollector(
  maxBytes: number,
  outputMode: CollectedProcessOutputMode,
): OutputCollector {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (outputMode === "truncate") {
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
          truncated = true;
          return false;
        }
        if (chunkBuffer.length <= remaining) {
          text += chunkBuffer.toString();
          bytes += chunkBuffer.length;
          return false;
        }
        text += chunkBuffer.subarray(0, remaining).toString();
        bytes += remaining;
        truncated = true;
        return false;
      }

      text += chunkBuffer.toString();
      bytes += chunkBuffer.length;
      return bytes > maxBytes;
    },
    finalize() {
      return {
        text,
        truncated,
      };
    },
  };
}

function makePartsCollector(
  maxBytes: number,
  outputMode: CollectedProcessOutputMode,
  truncatedMarker: string,
): OutputCollector {
  const decoder = new TextDecoder();
  const parts: Array<string> = [];
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (truncated && outputMode === "truncate") {
        return false;
      }

      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const remainingBytes = maxBytes - bytes;

      if (remainingBytes <= 0) {
        if (outputMode === "truncate") {
          if (truncatedMarker.length > 0) {
            parts.push(truncatedMarker);
          }
          truncated = true;
          return false;
        }

        bytes += chunkBuffer.byteLength;
        return bytes > maxBytes;
      }

      const nextChunk =
        outputMode === "truncate" && chunkBuffer.byteLength > remainingBytes
          ? chunkBuffer.subarray(0, remainingBytes)
          : chunkBuffer;
      const nextPart = decoder.decode(nextChunk, { stream: true });
      if (nextPart.length > 0) {
        parts.push(nextPart);
      }
      bytes += nextChunk.byteLength;

      if (outputMode === "truncate" && chunkBuffer.byteLength > remainingBytes) {
        if (truncatedMarker.length > 0) {
          parts.push(truncatedMarker);
        }
        truncated = true;
        return false;
      }

      return outputMode === "error" && bytes > maxBytes;
    },
    finalize() {
      return {
        text: truncated ? parts.join("") : `${parts.join("")}${decoder.decode()}`,
        truncated,
      };
    },
  };
}

function makeOutputCollector(
  maxBytes: number,
  outputMode: CollectedProcessOutputMode,
  collectorMode: CollectedProcessCollectorMode,
  truncatedMarker: string,
): OutputCollector {
  if (collectorMode === "concat") {
    return makeConcatCollector(maxBytes, outputMode);
  }
  return makePartsCollector(maxBytes, outputMode, truncatedMarker);
}

function isCollectedProcessError(value: unknown): value is CollectedProcessError {
  return (
    value instanceof CollectedProcessSpawnError ||
    value instanceof CollectedProcessStdinError ||
    value instanceof CollectedProcessOutputLimitError ||
    value instanceof CollectedProcessTimeoutError
  );
}

async function runCollectedProcessPromise(
  command: string,
  args: readonly string[],
  options: CollectedProcessRunOptions,
): Promise<CollectedProcessResult> {
  const collectorMode = options.collectorMode ?? "concat";
  const truncatedMarker = options.truncatedMarker ?? "";

  return new Promise<CollectedProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: "pipe",
      shell: options.shell ?? false,
    });

    const stdout = makeOutputCollector(
      options.maxOutputBytes,
      options.outputMode,
      collectorMode,
      truncatedMarker,
    );
    const stderr = makeOutputCollector(
      options.maxOutputBytes,
      options.outputMode,
      collectorMode,
      truncatedMarker,
    );
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
      finalize(() => reject(new CollectedProcessTimeoutError({ timeoutMs: options.timeoutMs })));
    }, options.timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: CollectedProcessError): void => {
      killChild(child, "SIGTERM");
      finalize(() => reject(error));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.append(chunk)) {
        fail(
          new CollectedProcessOutputLimitError({
            stream: "stdout",
            maxBytes: options.maxOutputBytes,
          }),
        );
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.append(chunk)) {
        fail(
          new CollectedProcessOutputLimitError({
            stream: "stderr",
            maxBytes: options.maxOutputBytes,
          }),
        );
      }
    });

    child.once("error", (cause) => {
      finalize(() => reject(new CollectedProcessSpawnError({ cause })));
    });

    child.once("close", (code, signal) => {
      const stdoutResult = stdout.finalize();
      const stderrResult = stderr.finalize();
      finalize(() =>
        resolve({
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          code,
          signal,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
        }),
      );
    });

    child.stdin?.once("error", (cause) => {
      fail(new CollectedProcessStdinError({ cause }));
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin, (cause) => {
        if (cause) {
          fail(new CollectedProcessStdinError({ cause }));
          return;
        }
        child.stdin?.end();
      });
      return;
    }

    child.stdin?.end();
  });
}

export function runCollectedProcess(
  command: string,
  args: readonly string[],
  options: CollectedProcessRunOptions,
): Effect.Effect<CollectedProcessResult, CollectedProcessError> {
  return Effect.tryPromise({
    try: () => runCollectedProcessPromise(command, args, options),
    catch: (cause) =>
      isCollectedProcessError(cause) ? cause : new CollectedProcessSpawnError({ cause }),
  });
}
