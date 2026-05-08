import { Context, Duration, Effect, Layer, Option, PlatformError, Sink, Stream } from "effect";
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
  readonly spawnCwd?: string;
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

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
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
    const baseError = {
      operation: input.operation,
      command: label,
      cwd: input.cwd,
    };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          cwd: input.spawnCwd ?? input.cwd,
          ...(input.env !== undefined
            ? {
                env: {
                  ...process.env,
                  ...input.env,
                },
              }
            : {}),
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
      Stream.mapError(
        (cause: PlatformError.PlatformError) =>
          new VcsOutputDecodeError({
            ...baseError,
            detail: `failed to read process ${streamName}`,
            cause,
          }),
      );
    const mapEffectError = (detail: string) =>
      Effect.mapError(
        (cause: PlatformError.PlatformError) =>
          new VcsOutputDecodeError({
            ...baseError,
            detail,
            cause,
          }),
      );
    const writeStdin = (stdin: string) =>
      Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
        mapEffectError("failed to write process stdin"),
      );

    return {
      pid: child.pid,
      stdin: child.stdin.pipe(
        Sink.mapError(
          (cause) =>
            new VcsOutputDecodeError({
              ...baseError,
              detail: "failed to write process stdin",
              cause,
            }),
        ),
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
    const baseError = {
      operation: input.operation,
      command: label,
      cwd: input.cwd,
    };
    const runProcess = Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd: input.spawnCwd ?? input.cwd,
            ...(input.env !== undefined
              ? {
                  env: {
                    ...process.env,
                    ...input.env,
                  },
                }
              : {}),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessSpawnError({
                ...baseError,
                cause,
              }),
          ),
        );

      const mapStreamError = (streamName: "stdout" | "stderr") =>
        Stream.mapError(
          (cause: PlatformError.PlatformError) =>
            new VcsOutputDecodeError({
              ...baseError,
              detail: `failed to read process ${streamName}`,
              cause,
            }),
        );

      const writeStdin =
        input.stdin === undefined
          ? Effect.void
          : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
              Effect.mapError(
                (cause: PlatformError.PlatformError) =>
                  new VcsOutputDecodeError({
                    ...baseError,
                    detail: "failed to write process stdin",
                    cause,
                  }),
              ),
            );

      const [stdout, stderr] = yield* Effect.all(
        [
          collectText({
            operation: input.operation,
            command: label,
            cwd: input.cwd,
            stream: child.stdout.pipe(mapStreamError("stdout")),
            maxOutputBytes,
            truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes ?? false,
          }),
          collectText({
            operation: input.operation,
            command: label,
            cwd: input.cwd,
            stream: child.stderr.pipe(mapStreamError("stderr")),
            maxOutputBytes,
            truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes ?? false,
          }),
          writeStdin,
        ],
        { concurrency: "unbounded" },
      );

      const exitCode = yield* child.exitCode.pipe(
        Effect.mapError(
          (cause: PlatformError.PlatformError) =>
            new VcsOutputDecodeError({
              ...baseError,
              detail: "failed to read process exit code",
              cause,
            }),
        ),
      );

      if (!input.allowNonZeroExit && exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: input.operation,
          command: label,
          cwd: input.cwd,
          exitCode,
          detail: stderr.text.trim() || `${label} exited with code ${exitCode}.`,
        });
      }

      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies VcsProcessOutput;
    });

    return yield* runProcess.pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                ...baseError,
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
