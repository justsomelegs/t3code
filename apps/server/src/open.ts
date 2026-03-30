/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  EDITORS,
  type EditorId,
  type ServerExecutionEnvironment,
  type ServerHostRuntime,
} from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Stream } from "effect";

import {
  resolveCommandCandidates,
  resolveExecutableFile,
  resolvePathEnvironmentVariable,
  resolveWindowsPathExtensions,
  stripWrappingQuotes,
} from "./commandResolution";
import { inferExecutionEnvironmentFromCwd } from "./executionEnvironment";
import { parseWslUncPath, resolveWslWorkingDirectory } from "./pathInterop";
import { makeRuntimeCommand, resolveProcessLaunchPlan } from "./processRunner";
import { RuntimeEnvironmentLive } from "./runtimeEnvironment/Layers/RuntimeEnvironment";
import { RuntimeEnvironment } from "./runtimeEnvironment/Services/RuntimeEnvironment";

// ==============================
// Definitions
// ==============================

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  operation: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_LINE_COLUMN_SUFFIX_PATTERN = /(.*?)(:\d+(?::\d+)?)$/;

function shouldUseGotoFlag(editorId: EditorId, target: string): boolean {
  return (
    (editorId === "cursor" || editorId === "vscode") && LINE_COLUMN_SUFFIX_PATTERN.test(target)
  );
}

function fileManagerCommandForRuntime(
  platform: NodeJS.Platform,
  hostRuntime?: ServerHostRuntime,
): string {
  if (hostRuntime?.isWsl) {
    return "explorer.exe";
  }

  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer.exe";
    default:
      return "xdg-open";
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some(
      (candidate) =>
        resolveExecutableFile(candidate, {
          platform,
          windowsPathExtensions,
        }) !== null,
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (
        resolveExecutableFile(join(pathEntry, candidate), {
          platform,
          windowsPathExtensions,
        }) !== null
      ) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  hostRuntime?: ServerHostRuntime,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const command = editor.command ?? fileManagerCommandForRuntime(platform, hostRuntime);
    if (isCommandAvailable(command, { platform, env })) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

function splitTargetSuffix(target: string): {
  readonly path: string;
  readonly suffix: string;
} {
  const match = target.match(WINDOWS_LINE_COLUMN_SUFFIX_PATTERN);
  if (!match?.[1] || !match[2]) {
    return { path: target, suffix: "" };
  }

  const maybeWindowsDrivePath = match[1].match(/^[A-Za-z]:$/);
  if (maybeWindowsDrivePath) {
    return { path: target, suffix: "" };
  }

  return {
    path: match[1],
    suffix: match[2],
  };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

type TranslateWslPathToWindowsPath = (params: {
  readonly targetPath: string;
  readonly executionEnvironment: Extract<ServerExecutionEnvironment, { kind: "wsl" }>;
  readonly hostRuntime: ServerHostRuntime;
}) => Effect.Effect<string, OpenError>;

function resolveOpenExecutionEnvironment(params: {
  readonly target: string;
  readonly hostRuntime: ServerHostRuntime;
  readonly availableExecutionEnvironments: ReadonlyArray<ServerExecutionEnvironment>;
}): ServerExecutionEnvironment {
  return inferExecutionEnvironmentFromCwd({
    cwd: params.target,
    hostRuntime: params.hostRuntime,
    availableExecutionEnvironments: params.availableExecutionEnvironments,
  });
}

function resolveWslPathForWindowsInterop(params: {
  readonly targetPath: string;
  readonly executionEnvironment: Extract<ServerExecutionEnvironment, { kind: "wsl" }>;
}): { readonly distroName: string | null; readonly path: string } {
  const uncPath = parseWslUncPath(params.targetPath);
  if (uncPath) {
    return {
      distroName: uncPath.distroName,
      path: uncPath.path,
    };
  }

  const { distroName, cwd } = resolveWslWorkingDirectory({
    cwd: params.targetPath,
    executionEnvironment: params.executionEnvironment,
  });

  if (!cwd) {
    throw new Error("WSL path translation requires a concrete path.");
  }

  return {
    distroName,
    path: cwd,
  };
}

export function normalizeEditorTargetForRuntime(params: {
  readonly target: string;
  readonly editor: EditorId;
  readonly hostRuntime: ServerHostRuntime;
  readonly availableExecutionEnvironments: ReadonlyArray<ServerExecutionEnvironment>;
  readonly translateWslPathToWindowsPath: TranslateWslPathToWindowsPath;
}): Effect.Effect<string, OpenError> {
  return Effect.gen(function* () {
    const { path, suffix } = splitTargetSuffix(params.target);
    const executionEnvironment = resolveOpenExecutionEnvironment({
      target: path,
      hostRuntime: params.hostRuntime,
      availableExecutionEnvironments: params.availableExecutionEnvironments,
    });

    if (params.hostRuntime.osFamily === "windows" && executionEnvironment.kind === "wsl") {
      const translatedPath = yield* params.translateWslPathToWindowsPath({
        targetPath: path,
        executionEnvironment,
        hostRuntime: params.hostRuntime,
      });
      return `${translatedPath}${suffix}`;
    }

    if (params.hostRuntime.isWsl && params.editor === "file-manager") {
      const translatedPath = yield* params.translateWslPathToWindowsPath({
        targetPath: path,
        executionEnvironment: { kind: "wsl", distroName: params.hostRuntime.wslDistroName },
        hostRuntime: params.hostRuntime,
      });
      return `${translatedPath}${suffix}`;
    }

    return params.target;
  });
}

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly hostRuntime?: ServerHostRuntime;
  } = {},
): Effect.fn.Return<EditorLaunch, OpenError> {
  const platform = options.platform ?? process.platform;
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({
      operation: "open.resolveEditorLaunch",
      reason: "unknown-editor",
      message: `Unknown editor: ${input.editor}`,
    });
  }

  if (editorDef.command) {
    return shouldUseGotoFlag(editorDef.id, input.cwd)
      ? { command: editorDef.command, args: ["--goto", input.cwd] }
      : { command: editorDef.command, args: [input.cwd] };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({
      operation: "open.resolveEditorLaunch",
      reason: "unsupported-editor",
      message: `Unsupported editor: ${input.editor}`,
    });
  }

  return {
    command: fileManagerCommandForRuntime(platform, options.hostRuntime),
    args: [input.cwd],
  };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({
        operation: "open.launchDetached",
        reason: "command-not-found",
        message: `Editor command not found: ${launch.command}`,
      });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        const launchPlan = resolveProcessLaunchPlan(launch.command, launch.args);
        child = spawn(launchPlan.command, [...launchPlan.args], {
          detached: true,
          stdio: "ignore",
          shell: launchPlan.shell,
        });
      } catch (error) {
        return resume(
          Effect.fail(
            new OpenError({
              operation: "open.launchDetached",
              reason: "spawn-failed",
              message: "failed to spawn detached process",
              cause: error,
            }),
          ),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(
          Effect.fail(
            new OpenError({
              operation: "open.launchDetached",
              reason: "spawn-failed",
              message: "failed to spawn detached process",
              cause,
            }),
          ),
        ),
      );
    });
  });

const make = Effect.gen(function* () {
  const runtimeEnvironment = yield* RuntimeEnvironment;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runCommandCapture = (params: {
    readonly operation: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly hostRuntime?: ServerHostRuntime | undefined;
    readonly executionEnvironment?: ServerExecutionEnvironment | undefined;
  }): Effect.Effect<string, OpenError> =>
    Effect.gen(function* () {
      const command = makeRuntimeCommand(params.command, params.args, {
        cwd: params.cwd,
        env: params.env,
        hostRuntime: params.hostRuntime,
        executionEnvironment: params.executionEnvironment,
      });

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new OpenError({
              operation: params.operation,
              reason: "spawn-failed",
              message: `Failed to spawn ${params.command}.`,
              cause,
            }),
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new OpenError({
                  operation: params.operation,
                  reason: "stdout-read-failed",
                  message: `Failed to read stdout from ${params.command}.`,
                  cause,
                }),
            ),
          ),
          collectStreamAsString(child.stderr).pipe(
            Effect.mapError(
              (cause) =>
                new OpenError({
                  operation: params.operation,
                  reason: "stderr-read-failed",
                  message: `Failed to read stderr from ${params.command}.`,
                  cause,
                }),
            ),
          ),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(
              (cause) =>
                new OpenError({
                  operation: params.operation,
                  reason: "exit-code-read-failed",
                  message: `Failed to read exit code from ${params.command}.`,
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new OpenError({
          operation: params.operation,
          reason: "command-failed",
          message:
            (stderr ?? "").trim().length > 0
              ? (stderr ?? "").trim()
              : (stdout ?? "").trim().length > 0
                ? (stdout ?? "").trim()
                : `${params.command} exited with code ${exitCode}.`,
        });
      }

      return (stdout ?? "").trim();
    }).pipe(Effect.scoped);

  const translateWslPathToWindowsPath: TranslateWslPathToWindowsPath = (params) =>
    Effect.gen(function* () {
      const resolved = yield* Effect.try({
        try: () => resolveWslPathForWindowsInterop(params),
        catch: (cause) =>
          new OpenError({
            operation: "open.translateWslPathToWindowsPath",
            reason: "invalid-wsl-path",
            message: `Cannot translate WSL path: ${params.targetPath}`,
            cause,
          }),
      });

      return yield* runCommandCapture({
        operation: "open.translateWslPathToWindowsPath",
        command: params.hostRuntime.osFamily === "windows" ? "wsl.exe" : "wslpath",
        args:
          params.hostRuntime.osFamily === "windows"
            ? [
                ...(resolved.distroName ? ["--distribution", resolved.distroName] : []),
                "--exec",
                "wslpath",
                "-w",
                resolved.path,
              ]
            : ["-w", resolved.path],
        hostRuntime: params.hostRuntime,
      });
    });

  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) =>
      new OpenError({
        operation: "open.make",
        reason: "load-opener-failed",
        message: "failed to load browser opener",
        cause,
      }),
  });

  return {
    openBrowser: (target) =>
      Effect.gen(function* () {
        const { hostRuntime } = yield* runtimeEnvironment.getRuntimeEnvironment;

        if (hostRuntime.isWsl && isCommandAvailable("wslview")) {
          return yield* launchDetached({
            command: "wslview",
            args: [target],
          }).pipe(Effect.asVoid);
        }

        return yield* Effect.tryPromise({
          try: () => open.default(target),
          catch: (cause) =>
            new OpenError({
              operation: "open.openBrowser",
              reason: "browser-open-failed",
              message: "Browser auto-open failed",
              cause,
            }),
        });
      }),
    openInEditor: (input) =>
      Effect.gen(function* () {
        const details = yield* runtimeEnvironment.getRuntimeEnvironment;
        const target = yield* normalizeEditorTargetForRuntime({
          target: input.cwd,
          editor: input.editor,
          hostRuntime: details.hostRuntime,
          availableExecutionEnvironments: details.availableExecutionEnvironments,
          translateWslPathToWindowsPath,
        });
        const launch = yield* resolveEditorLaunch(
          { ...input, cwd: target },
          {
            hostRuntime: details.hostRuntime,
          },
        );
        return yield* launchDetached(launch);
      }),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make).pipe(Layer.provideMerge(RuntimeEnvironmentLive));
