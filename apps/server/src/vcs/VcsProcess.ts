import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessCollectedText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface VcsProcessHandle {
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly stdin: Sink.Sink<void, Uint8Array, never, VcsError>;
  readonly stdout: Stream.Stream<Uint8Array, VcsError>;
  readonly stderr: Stream.Stream<Uint8Array, VcsError>;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, VcsError>;
  readonly writeStdin: (input: string) => Effect.Effect<void, VcsError>;
}

export interface VcsProcessShape {
  readonly withProcess: <A, E, R>(
    input: VcsProcessInput,
    use: (handle: VcsProcessHandle) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | VcsError, R>;
  readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
}

export class VcsProcess extends Context.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/VcsProcess",
) {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

interface CollectedOutputState {
  readonly decoder: TextDecoder;
  readonly parts: Array<string>;
  readonly bytes: number;
  readonly truncated: boolean;
}

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function outputDecodeError(
  input: VcsProcessInput,
  detail: string,
  cause: unknown,
): VcsOutputDecodeError {
  return new VcsOutputDecodeError({
    operation: input.operation,
    command: commandLabel(input.command, input.args),
    cwd: input.cwd,
    detail,
    cause,
  });
}

function killChild(child: NodeChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
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

function appendCollectedChunk(
  state: CollectedOutputState,
  chunk: Uint8Array,
  maxBytes: number,
  truncatedMarker: string,
): CollectedOutputState {
  if (state.truncated) {
    return state;
  }

  const remainingBytes = maxBytes - state.bytes;
  if (remainingBytes <= 0) {
    return {
      ...state,
      parts: truncatedMarker.length === 0 ? state.parts : [...state.parts, truncatedMarker],
      truncated: true,
    };
  }

  const nextChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
  const nextPart = state.decoder.decode(nextChunk, { stream: true });
  const nextParts = nextPart.length === 0 ? state.parts : [...state.parts, nextPart];
  const truncated = chunk.byteLength > remainingBytes;

  return {
    decoder: state.decoder,
    parts: truncated && truncatedMarker.length > 0 ? [...nextParts, truncatedMarker] : nextParts,
    bytes: state.bytes + nextChunk.byteLength,
    truncated,
  };
}

function finalizeCollectedOutput(state: CollectedOutputState): {
  readonly text: string;
  readonly truncated: boolean;
} {
  return {
    text: state.truncated
      ? state.parts.join("")
      : `${state.parts.join("")}${state.decoder.decode()}`,
    truncated: state.truncated,
  };
}

export const collectText = Effect.fn("VcsProcess.collectText")(function* (input: {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly stream: Stream.Stream<Uint8Array, VcsError>;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}) {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return yield* collectUint8StreamText({
    stream: input.stream,
    maxBytes: maxOutputBytes,
    truncatedMarker: input.truncateOutputAtMaxBytes ? OUTPUT_TRUNCATED_MARKER : null,
  });
});

export const make = Effect.fn("makeVcsProcess")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fn("VcsProcess.spawn")(function* (input: VcsProcessInput) {
    const label = commandLabel(input.command, input.args);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.env,
          },
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessSpawnError({
              operation: input.operation,
              command: label,
              cwd: input.cwd,
              cause,
            }),
        ),
      );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

    const mapStreamError = (streamName: "stdout" | "stderr") =>
      Stream.mapError((cause: PlatformError.PlatformError) =>
        outputDecodeError(input, `failed to read process ${streamName}`, cause),
      );
    const mapEffectError = (detail: string) =>
      Effect.mapError((cause: PlatformError.PlatformError) =>
        outputDecodeError(input, detail, cause),
      );
    const writeStdin = (stdin: string) =>
      Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
        mapEffectError("failed to write process stdin"),
      );

    return {
      pid: child.pid,
      stdin: child.stdin.pipe(
        Sink.mapError((cause) => outputDecodeError(input, "failed to write process stdin", cause)),
      ),
      stdout: child.stdout.pipe(mapStreamError("stdout")),
      stderr: child.stderr.pipe(mapStreamError("stderr")),
      exitCode: child.exitCode.pipe(mapEffectError("failed to read process exit code")),
      writeStdin,
    } satisfies VcsProcessHandle;
  });

  const withProcess: VcsProcessShape["withProcess"] = (input, use) =>
    Effect.scoped(spawn(input).pipe(Effect.flatMap(use)));

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const label = commandLabel(input.command, input.args);
    const truncatedMarker = input.truncateOutputAtMaxBytes ? OUTPUT_TRUNCATED_MARKER : "";
    const runProcess = Effect.callback<VcsProcessOutput, VcsError>((resume) => {
      const processHandle = spawnChildProcess(input.command, [...input.args], {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutState: CollectedOutputState = {
        decoder: new TextDecoder(),
        parts: [],
        bytes: 0,
        truncated: false,
      };
      let stderrState: CollectedOutputState = {
        decoder: new TextDecoder(),
        parts: [],
        bytes: 0,
        truncated: false,
      };
      let done = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (effect: Effect.Effect<VcsProcessOutput, VcsError>) => {
        if (done) {
          return;
        }
        done = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        resume(effect);
      };

      processHandle.on("error", (cause) => {
        finish(
          Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: label,
              cwd: input.cwd,
              cause,
            }),
          ),
        );
      });

      processHandle.stdout?.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        stdoutState = appendCollectedChunk(stdoutState, bytes, maxOutputBytes, truncatedMarker);
      });

      processHandle.stderr?.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        stderrState = appendCollectedChunk(stderrState, bytes, maxOutputBytes, truncatedMarker);
      });

      processHandle.stdin?.on("error", (cause) => {
        finish(Effect.fail(outputDecodeError(input, "failed to write process stdin", cause)));
      });

      processHandle.on("close", (code, signal) => {
        if (done) {
          return;
        }

        if (code === null) {
          finish(
            Effect.fail(
              outputDecodeError(
                input,
                `failed to read process exit code${signal ? ` (signal: ${signal})` : ""}`,
                new Error(
                  `Process exited without exit code${signal ? ` (signal: ${signal})` : ""}.`,
                ),
              ),
            ),
          );
          return;
        }

        const stdout = finalizeCollectedOutput(stdoutState);
        const stderr = finalizeCollectedOutput(stderrState);
        const exitCode = ChildProcessSpawner.ExitCode(code);

        if (!input.allowNonZeroExit && code !== 0) {
          finish(
            Effect.fail(
              new VcsProcessExitError({
                operation: input.operation,
                command: label,
                cwd: input.cwd,
                exitCode,
                detail: stderr.text.trim() || `${label} exited with code ${code}.`,
              }),
            ),
          );
          return;
        }

        finish(
          Effect.succeed({
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          }),
        );
      });

      if (input.stdin !== undefined) {
        processHandle.stdin?.write(input.stdin, (cause) => {
          if (cause) {
            finish(Effect.fail(outputDecodeError(input, "failed to write process stdin", cause)));
            return;
          }
          processHandle.stdin?.end();
        });
      } else {
        processHandle.stdin?.end();
      }

      return Effect.sync(() => {
        if (!done) {
          killChild(processHandle, "SIGTERM");
          forceKillTimer = setTimeout(() => {
            killChild(processHandle, "SIGKILL");
          }, 1_000);
        }
      });
    });

    return yield* runProcess.pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: input.operation,
                command: label,
                cwd: input.cwd,
                timeoutMs,
              }),
            ),
        }),
      ),
    );
  });

  return VcsProcess.of({ withProcess, run });
});

export const layer = Layer.effect(VcsProcess, make());
