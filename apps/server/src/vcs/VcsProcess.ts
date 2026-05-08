import { Context, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import {
  ProcessOutputLimitError,
  ProcessReadError,
  runProcess,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
} from "../processRunner.ts";

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
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessShape {
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

export const make = Effect.fn("makeVcsProcess")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const label = commandLabel(input.command, input.args);
    const baseError = {
      operation: input.operation,
      command: label,
      cwd: input.cwd,
    };

    const result = yield* runProcess({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
      timeoutBehavior: "error",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => {
        if (cause instanceof ProcessSpawnError) {
          return new VcsProcessSpawnError({
            ...baseError,
            cause: cause.cause,
          });
        }
        if (cause instanceof ProcessStdinError) {
          return new VcsOutputDecodeError({
            ...baseError,
            detail: "failed to write process stdin",
            cause: cause.cause,
          });
        }
        if (cause instanceof ProcessReadError) {
          return new VcsOutputDecodeError({
            ...baseError,
            detail:
              cause.stream === "exitCode"
                ? "failed to read process exit code"
                : `failed to read process ${cause.stream}`,
            cause: cause.cause,
          });
        }
        if (cause instanceof ProcessOutputLimitError) {
          return new VcsOutputDecodeError({
            ...baseError,
            detail: `process ${cause.stream} exceeded ${cause.maxBytes} bytes`,
          });
        }
        if (cause instanceof ProcessTimeoutError) {
          return new VcsProcessTimeoutError({
            ...baseError,
            timeoutMs: cause.timeoutMs,
          });
        }
        return cause;
      }),
    );

    if (result.code === null) {
      return yield* new VcsOutputDecodeError({
        ...baseError,
        detail: "process completed without an exit code",
      });
    }

    const exitCode = result.code as ChildProcessSpawner.ExitCode;

    if (!input.allowNonZeroExit && exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: input.operation,
        command: label,
        cwd: input.cwd,
        exitCode,
        detail: result.stderr.trim() || `${label} exited with code ${exitCode}.`,
      });
    }

    return {
      exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    } satisfies VcsProcessOutput;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make());
