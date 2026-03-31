import nodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  RuntimeEnvironment,
  type RuntimeEnvironmentShape,
} from "../../runtimeEnvironment/Services/RuntimeEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

const defaultRuntimeEnvironmentService: RuntimeEnvironmentShape = {
  getRuntimeEnvironment: Effect.succeed({
    hostRuntime: {
      rawPlatform: "win32",
      osFamily: "windows",
      pathStyle: "windows",
      isWsl: false,
      wslDistroName: null,
    },
    availableExecutionEnvironments: [{ kind: "host" }],
  }),
  getHostRuntime: Effect.succeed({
    rawPlatform: "win32",
    osFamily: "windows",
    pathStyle: "windows",
    isWsl: false,
    wslDistroName: null,
  }),
  getAvailableExecutionEnvironments: Effect.succeed([{ kind: "host" }]),
};

const ClaudeTextGenerationTestLayer = ClaudeTextGenerationLive.pipe(
  Layer.provideMerge(Layer.succeed(RuntimeEnvironment, defaultRuntimeEnvironmentService)),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-claude-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const claudePath = path.join(binDir, "claude");
    const claudeCmdPath = path.join(binDir, "claude.cmd");
    const claudeScriptPath = path.join(binDir, "claude.cjs");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      claudeScriptPath,
      [
        'const args = process.argv.slice(2).join(" ");',
        "const stdinChunks = [];",
        'process.stdin.on("data", (chunk) => stdinChunks.push(Buffer.from(chunk)));',
        'process.stdin.on("end", () => {',
        '  const stdinContent = Buffer.concat(stdinChunks).toString("utf8");',
        "  const mustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "  const mustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        '  const mustContainAll = JSON.parse(process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL ?? "[]");',
        '  const mustNotContainAll = JSON.parse(process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL ?? "[]");',
        "  const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        '  const normalizedArgs = args.replaceAll(\'"\', "");',
        '  const normalizedMustContain = mustContain?.replaceAll(\'"\', "");',
        '  const normalizedMustNotContain = mustNotContain?.replaceAll(\'"\', "");',
        "  if (normalizedMustContain && !normalizedArgs.includes(normalizedMustContain)) {",
        '    process.stderr.write("args missing expected content\\n");',
        "    process.exit(2);",
        "  }",
        "  if (normalizedMustNotContain && normalizedArgs.includes(normalizedMustNotContain)) {",
        '    process.stderr.write("args contained forbidden content\\n");',
        "    process.exit(3);",
        "  }",
        '  if (mustContainAll.some((entry) => !normalizedArgs.includes(String(entry).replaceAll(\'"\', "")))) {',
        '    process.stderr.write("args missing expected content\\n");',
        "    process.exit(2);",
        "  }",
        '  if (mustNotContainAll.some((entry) => normalizedArgs.includes(String(entry).replaceAll(\'"\', "")))) {',
        '    process.stderr.write("args contained forbidden content\\n");',
        "    process.exit(3);",
        "  }",
        "  if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '    process.stderr.write("stdin missing expected content\\n");',
        "    process.exit(4);",
        "  }",
        "  if (process.env.T3_FAKE_CLAUDE_STDERR) {",
        "    process.stderr.write(`${process.env.T3_FAKE_CLAUDE_STDERR}\\n`);",
        "  }",
        '  process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        '  process.exit(Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? "0"));',
        "});",
        "process.stdin.resume();",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(claudePath, ["#!/bin/sh", 'exec node "$0.cjs" "$@"', ""].join("\n"));
    yield* fs.chmod(claudePath, 0o755);
    yield* fs.writeFileString(
      claudeCmdPath,
      ["@echo off", 'node "%~dp0claude.cjs" %*', ""].join("\r\n"),
    );
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    argsMustContainAll?: ReadonlyArray<string>;
    argsMustNotContainAll?: ReadonlyArray<string>;
    stdinMustContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
      const binDir = yield* makeFakeClaudeBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
      const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
      const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
      const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
      const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
      const previousArgsMustContainAll = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL;
      const previousArgsMustNotContainAll = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL;
      const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}${nodePath.delimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.argsMustContainAll !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL = JSON.stringify(
            input.argsMustContainAll,
          );
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL;
        }

        if (input.argsMustNotContainAll !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL = JSON.stringify(
            input.argsMustNotContainAll,
          );
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }
      });

      return {
        previousPath,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousArgsMustContain,
        previousArgsMustNotContain,
        previousArgsMustContainAll,
        previousArgsMustNotContainAll,
        previousStdinMustContain,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;

        if (previous.previousOutput === undefined) {
          delete process.env.T3_FAKE_CLAUDE_OUTPUT;
        } else {
          process.env.T3_FAKE_CLAUDE_OUTPUT = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        } else {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        } else {
          process.env.T3_FAKE_CLAUDE_STDERR = previous.previousStderr;
        }

        if (previous.previousArgsMustContain === undefined) {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        } else {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previous.previousArgsMustContain;
        }

        if (previous.previousArgsMustNotContain === undefined) {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        } else {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previous.previousArgsMustNotContain;
        }

        if (previous.previousArgsMustContainAll === undefined) {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL;
        } else {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN_ALL = previous.previousArgsMustContainAll;
        }

        if (previous.previousArgsMustNotContainAll === undefined) {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL;
        } else {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN_ALL =
            previous.previousArgsMustNotContainAll;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        } else {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }
      }),
  );
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGenerationLive", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContainAll: ["--settings", "alwaysThinkingEnabled:false"],
        argsMustNotContainAll: ["--effort"],
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/claude-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-haiku-4-5",
            options: {
              thinking: false,
              effort: "high",
            },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContainAll: ["--effort", "max", "--settings", "fastMode:true"],
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/claude-effect",
          commitSummary: "Improve orchestration",
          diffSummary: "1 file changed",
          diffPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        });

        expect(generated.title).toBe("Improve orchestration flow");
      }),
    ),
  );
});
