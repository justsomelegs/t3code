import type { ServerExecutionEnvironment } from "@t3tools/contracts";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WSL_UNC_PATH_PATTERN = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(?:\\(.*))?$/i;

export interface ResolvedWslWorkingDirectory {
  readonly distroName: string | null;
  readonly cwd: string | undefined;
}

export function isWindowsDrivePath(path: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(path);
}

export function isPosixPath(path: string): boolean {
  return path.startsWith("/");
}

export function parseWslUncPath(path: string): {
  readonly distroName: string;
  readonly path: string;
} | null {
  const match = path.match(WSL_UNC_PATH_PATTERN);
  if (!match) {
    return null;
  }

  const distroName = match[1]!;
  const relativePath = match[2] ?? "";
  const normalizedPath = `/${relativePath.replaceAll("\\", "/")}`.replace(/\/+/g, "/");
  return {
    distroName,
    path: normalizedPath === "/" ? "/" : normalizedPath.replace(/\/$/u, ""),
  };
}

export function translateWindowsPathToWslPath(path: string): string | null {
  if (!isWindowsDrivePath(path)) {
    return null;
  }

  const driveLetter = path[0]!.toLowerCase();
  const normalizedPath = path.slice(2).replaceAll("\\", "/");
  return `/mnt/${driveLetter}${normalizedPath}`;
}

export function resolveWslWorkingDirectory(options: {
  readonly cwd?: string | undefined;
  readonly executionEnvironment: Extract<ServerExecutionEnvironment, { kind: "wsl" }>;
}): ResolvedWslWorkingDirectory {
  const cwd = options.cwd;
  if (cwd === undefined) {
    return {
      distroName: options.executionEnvironment.distroName,
      cwd: undefined,
    };
  }

  const uncPath = parseWslUncPath(cwd);
  if (uncPath) {
    if (
      options.executionEnvironment.distroName !== null &&
      options.executionEnvironment.distroName !== uncPath.distroName
    ) {
      throw new Error(
        `Workspace path belongs to WSL distro ${uncPath.distroName}, but ${options.executionEnvironment.distroName} was requested.`,
      );
    }

    return {
      distroName: uncPath.distroName,
      cwd: uncPath.path,
    };
  }

  if (isPosixPath(cwd)) {
    return {
      distroName: options.executionEnvironment.distroName,
      cwd,
    };
  }

  const translatedDrivePath = translateWindowsPathToWslPath(cwd);
  if (translatedDrivePath !== null) {
    return {
      distroName: options.executionEnvironment.distroName,
      cwd: translatedDrivePath,
    };
  }

  throw new Error(`Cannot translate workspace path for WSL execution: ${cwd}`);
}

export function resolveWslCommand(command: string): string {
  const uncPath = parseWslUncPath(command);
  if (uncPath) {
    return uncPath.path;
  }

  if (isWindowsDrivePath(command)) {
    throw new Error(
      `WSL execution requires a Linux command path or PATH command, but received Windows path: ${command}`,
    );
  }

  if (command.includes("\\")) {
    throw new Error(
      `WSL execution requires a Linux command path or PATH command, but received Windows-style command: ${command}`,
    );
  }

  return command;
}
