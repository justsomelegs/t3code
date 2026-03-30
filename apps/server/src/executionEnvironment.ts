import type { ServerExecutionEnvironment, ServerHostRuntime } from "@t3tools/contracts";

import { isPosixPath, parseWslUncPath } from "./pathInterop";

export type ExecutionEnvironmentPreference =
  | {
      readonly kind: "auto";
    }
  | {
      readonly kind: "host";
    }
  | {
      readonly kind: "wsl";
      readonly distroName: string | null;
    };

interface ResolveExecutionEnvironmentOptions {
  readonly hostRuntime: ServerHostRuntime;
  readonly availableExecutionEnvironments: ReadonlyArray<ServerExecutionEnvironment>;
  readonly preference?: ExecutionEnvironmentPreference | undefined;
}

interface InferExecutionEnvironmentFromCwdOptions {
  readonly cwd: string;
  readonly hostRuntime: ServerHostRuntime;
  readonly availableExecutionEnvironments: ReadonlyArray<ServerExecutionEnvironment>;
}

function isMatchingWslEnvironment(
  environment: ServerExecutionEnvironment,
  distroName: string | null,
): environment is Extract<ServerExecutionEnvironment, { kind: "wsl" }> {
  return environment.kind === "wsl" && environment.distroName === distroName;
}

export function resolveExecutionEnvironment(
  options: ResolveExecutionEnvironmentOptions,
): ServerExecutionEnvironment {
  const preference = options.preference ?? { kind: "auto" };
  if (preference.kind === "auto" || preference.kind === "host") {
    return { kind: "host" };
  }

  if (options.hostRuntime.osFamily !== "windows") {
    throw new Error("WSL execution requires a Windows host.");
  }

  const availableWslEnvironments = options.availableExecutionEnvironments.filter(
    (environment): environment is Extract<ServerExecutionEnvironment, { kind: "wsl" }> =>
      environment.kind === "wsl",
  );

  if (availableWslEnvironments.length === 0) {
    throw new Error("WSL execution was requested, but no WSL distributions are available.");
  }

  if (preference.distroName === null) {
    return availableWslEnvironments[0]!;
  }

  const matchingEnvironment = options.availableExecutionEnvironments.find((environment) =>
    isMatchingWslEnvironment(environment, preference.distroName),
  );

  if (!matchingEnvironment) {
    throw new Error(`WSL distribution is not available: ${preference.distroName}`);
  }

  return matchingEnvironment;
}

export function inferExecutionEnvironmentFromCwd(
  options: InferExecutionEnvironmentFromCwdOptions,
): ServerExecutionEnvironment {
  if (options.hostRuntime.osFamily !== "windows") {
    return { kind: "host" };
  }

  const uncPath = parseWslUncPath(options.cwd);
  if (uncPath) {
    return resolveExecutionEnvironment({
      hostRuntime: options.hostRuntime,
      availableExecutionEnvironments: options.availableExecutionEnvironments,
      preference: {
        kind: "wsl",
        distroName: uncPath.distroName,
      },
    });
  }

  if (isPosixPath(options.cwd)) {
    return resolveExecutionEnvironment({
      hostRuntime: options.hostRuntime,
      availableExecutionEnvironments: options.availableExecutionEnvironments,
      preference: {
        kind: "wsl",
        distroName: null,
      },
    });
  }

  return { kind: "host" };
}
