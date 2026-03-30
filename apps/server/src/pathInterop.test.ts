import { describe, expect, it } from "vitest";

import {
  parseWslUncPath,
  resolveWslCommand,
  resolveWslWorkingDirectory,
  translateWindowsPathToWslPath,
} from "./pathInterop";

describe("parseWslUncPath", () => {
  it("parses \\\\wsl$ distro paths", () => {
    expect(parseWslUncPath("\\\\wsl$\\Ubuntu-24.04\\home\\mike\\repo")).toEqual({
      distroName: "Ubuntu-24.04",
      path: "/home/mike/repo",
    });
  });

  it("parses \\\\wsl.localhost distro paths", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Arch\\tmp\\workspace")).toEqual({
      distroName: "Arch",
      path: "/tmp/workspace",
    });
  });

  it("returns null for non-WSL UNC paths", () => {
    expect(parseWslUncPath("\\\\server\\share\\workspace")).toBeNull();
  });
});

describe("translateWindowsPathToWslPath", () => {
  it("translates drive paths to /mnt paths", () => {
    expect(translateWindowsPathToWslPath("C:\\Users\\mike\\repo")).toBe("/mnt/c/Users/mike/repo");
  });

  it("returns null for non-drive paths", () => {
    expect(translateWindowsPathToWslPath("/home/mike/repo")).toBeNull();
  });
});

describe("resolveWslWorkingDirectory", () => {
  it("infers distro and POSIX cwd from WSL UNC workspace paths", () => {
    expect(
      resolveWslWorkingDirectory({
        cwd: "\\\\wsl$\\Ubuntu-24.04\\home\\mike\\repo",
        executionEnvironment: {
          kind: "wsl",
          distroName: null,
        },
      }),
    ).toEqual({
      distroName: "Ubuntu-24.04",
      cwd: "/home/mike/repo",
    });
  });

  it("translates Windows host paths into /mnt paths", () => {
    expect(
      resolveWslWorkingDirectory({
        cwd: "D:\\dev\\repo",
        executionEnvironment: {
          kind: "wsl",
          distroName: "Ubuntu-24.04",
        },
      }),
    ).toEqual({
      distroName: "Ubuntu-24.04",
      cwd: "/mnt/d/dev/repo",
    });
  });

  it("preserves POSIX paths for WSL execution", () => {
    expect(
      resolveWslWorkingDirectory({
        cwd: "/home/mike/repo",
        executionEnvironment: {
          kind: "wsl",
          distroName: "Ubuntu-24.04",
        },
      }),
    ).toEqual({
      distroName: "Ubuntu-24.04",
      cwd: "/home/mike/repo",
    });
  });

  it("fails when the requested distro does not match the workspace path distro", () => {
    expect(() =>
      resolveWslWorkingDirectory({
        cwd: "\\\\wsl$\\Arch\\home\\mike\\repo",
        executionEnvironment: {
          kind: "wsl",
          distroName: "Ubuntu-24.04",
        },
      }),
    ).toThrow("Workspace path belongs to WSL distro Arch, but Ubuntu-24.04 was requested.");
  });
});

describe("resolveWslCommand", () => {
  it("passes bare PATH commands through unchanged", () => {
    expect(resolveWslCommand("codex")).toBe("codex");
  });

  it("passes POSIX command paths through unchanged", () => {
    expect(resolveWslCommand("/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
  });

  it("translates WSL UNC command paths", () => {
    expect(resolveWslCommand("\\\\wsl$\\Ubuntu-24.04\\usr\\local\\bin\\codex")).toBe(
      "/usr/local/bin/codex",
    );
  });

  it("rejects Windows command paths", () => {
    expect(() => resolveWslCommand("C:\\tools\\codex.exe")).toThrow(
      "WSL execution requires a Linux command path or PATH command",
    );
  });
});
