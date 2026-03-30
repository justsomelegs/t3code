import { spawnSync } from "node:child_process";

import { Effect, Layer, Schema } from "effect";

import {
  detectServerRuntimeEnvironment,
  type DetectServerRuntimeEnvironmentOptions,
  type ServerRuntimeEnvironmentDetails,
  parseWslDistroList,
} from "../../runtimeEnvironment";
import { RuntimeEnvironment, type RuntimeEnvironmentShape } from "../Services/RuntimeEnvironment";

const WSL_DISTRO_LIST_TIMEOUT_MS = 1_500;

type RuntimeEnvironmentProbeReason =
  | "command-unavailable"
  | "timed-out"
  | "probe-failed"
  | "invalid-output";

export class RuntimeEnvironmentProbeError extends Schema.TaggedErrorClass<RuntimeEnvironmentProbeError>()(
  "RuntimeEnvironmentProbeError",
  {
    operation: Schema.String,
    reason: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function isCommandUnavailableError(error: Error): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  const lower = error.message.toLowerCase();
  return nodeError.code === "ENOENT" || lower.includes("enoent") || lower.includes("not found");
}

function isTimeoutError(error: Error): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === "ETIMEDOUT" || error.message.toLowerCase().includes("timed out");
}

function isNoInstalledDistributionOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("no installed distributions") ||
    normalized.includes("there are no installed distributions")
  );
}

const probeWindowsWslDistros: Effect.Effect<
  ReadonlyArray<string>,
  RuntimeEnvironmentProbeError
> = Effect.gen(function* () {
  const result = yield* Effect.try({
    try: () =>
      spawnSync("wsl.exe", ["-l", "-q"], {
        encoding: "utf8",
        timeout: WSL_DISTRO_LIST_TIMEOUT_MS,
        windowsHide: true,
      }),
    catch: (cause) => {
      const error =
        cause instanceof Error ? cause : new Error(`Unknown WSL probe failure: ${String(cause)}`);
      const reason: RuntimeEnvironmentProbeReason = isCommandUnavailableError(error)
        ? "command-unavailable"
        : isTimeoutError(error)
          ? "timed-out"
          : "probe-failed";
      return new RuntimeEnvironmentProbeError({
        operation: "probeWindowsWslDistros",
        reason,
        message: "Failed to execute `wsl.exe -l -q` while probing WSL availability.",
        cause,
      });
    },
  });

  if (result.error) {
    const reason: RuntimeEnvironmentProbeReason = isCommandUnavailableError(result.error)
      ? "command-unavailable"
      : isTimeoutError(result.error)
        ? "timed-out"
        : "probe-failed";
    const message =
      reason === "command-unavailable"
        ? "WSL probe command is unavailable on this host."
        : reason === "timed-out"
          ? "WSL probe timed out while listing installed distros."
          : "WSL distro probe exited with a process error.";

    return yield* new RuntimeEnvironmentProbeError({
      operation: "probeWindowsWslDistros",
      reason,
      message,
      cause: result.error,
    });
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const combinedOutput = `${stdout}\n${stderr}`;

  if (result.status !== 0) {
    if (isNoInstalledDistributionOutput(combinedOutput)) {
      return [];
    }

    return yield* new RuntimeEnvironmentProbeError({
      operation: "probeWindowsWslDistros",
      reason: "probe-failed",
      message:
        combinedOutput.trim().length > 0
          ? combinedOutput.trim()
          : `WSL distro probe exited with code ${String(result.status)}.`,
    });
  }

  if (typeof result.stdout !== "string") {
    return yield* new RuntimeEnvironmentProbeError({
      operation: "probeWindowsWslDistros",
      reason: "invalid-output",
      message: "WSL distro probe did not return UTF-8 text output.",
    });
  }

  return parseWslDistroList(result.stdout);
});

function logProbeFallback(error: RuntimeEnvironmentProbeError): Effect.Effect<void> {
  if (error.reason === "command-unavailable") {
    return Effect.logDebug("WSL probe unavailable; continuing without WSL execution environments", {
      operation: error.operation,
      reason: error.reason,
    });
  }

  return Effect.logWarning("WSL probe failed; continuing without WSL execution environments", {
    operation: error.operation,
    reason: error.reason,
    message: error.message,
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}

export function resolveRuntimeEnvironmentDetails(
  options: {
    readonly detectOptions?: DetectServerRuntimeEnvironmentOptions;
    readonly probeWindowsWslDistros?: Effect.Effect<
      ReadonlyArray<string>,
      RuntimeEnvironmentProbeError
    >;
  } = {},
): Effect.Effect<ServerRuntimeEnvironmentDetails> {
  return Effect.gen(function* () {
    const hostOnlyDetails = detectServerRuntimeEnvironment({
      ...options.detectOptions,
      listWindowsWslDistros: () => [],
    });

    if (hostOnlyDetails.hostRuntime.osFamily !== "windows") {
      return hostOnlyDetails;
    }

    const probe = options.probeWindowsWslDistros ?? probeWindowsWslDistros;
    const wslDistros = yield* probe.pipe(
      Effect.catchTag("RuntimeEnvironmentProbeError", (error) =>
        logProbeFallback(error).pipe(Effect.as([] as ReadonlyArray<string>)),
      ),
    );

    return detectServerRuntimeEnvironment({
      ...options.detectOptions,
      listWindowsWslDistros: () => wslDistros,
    });
  });
}

const makeRuntimeEnvironment: Effect.Effect<RuntimeEnvironmentShape> = Effect.gen(function* () {
  const details = yield* resolveRuntimeEnvironmentDetails();

  return {
    getRuntimeEnvironment: Effect.succeed(details),
    getHostRuntime: Effect.succeed(details.hostRuntime),
    getAvailableExecutionEnvironments: Effect.succeed(details.availableExecutionEnvironments),
  } satisfies RuntimeEnvironmentShape;
});

export const RuntimeEnvironmentLive = Layer.effect(RuntimeEnvironment, makeRuntimeEnvironment);
