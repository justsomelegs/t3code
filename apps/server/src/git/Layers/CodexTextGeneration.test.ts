import nodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5.4-mini",
};

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    const codexCmdPath = path.join(binDir, "codex.cmd");
    const codexScriptPath = path.join(binDir, "codex.cjs");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexScriptPath,
      [
        'const fs = require("node:fs");',
        'let outputPath = "";',
        "let seenImage = false;",
        "let seenFastServiceTier = false;",
        'let seenReasoningEffort = "";',
        "const args = process.argv.slice(2);",
        "for (let index = 0; index < args.length; index += 1) {",
        "  const arg = args[index];",
        '  if (arg === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        "    continue;",
        "  }",
        '  if (arg === "--config") {',
        "    index += 1;",
        '    if (typeof args[index] === "string" && args[index].includes("service_tier") && args[index].includes("fast")) {',
        "      seenFastServiceTier = true;",
        "    }",
        '    if (typeof args[index] === "string" && args[index].startsWith("model_reasoning_effort=")) {',
        "      seenReasoningEffort = args[index];",
        "    }",
        "    continue;",
        "  }",
        '  if (arg === "--output-last-message") {',
        "    index += 1;",
        '    outputPath = args[index] ?? "";',
        "  }",
        "}",
        "const stdinChunks = [];",
        'process.stdin.on("data", (chunk) => stdinChunks.push(Buffer.from(chunk)));',
        'process.stdin.on("end", () => {',
        '  const stdinContent = Buffer.concat(stdinChunks).toString("utf8");',
        '  if (process.env.T3_FAKE_CODEX_REQUIRE_IMAGE === "1" && !seenImage) {',
        '    process.stderr.write("missing --image input\\n");',
        "    process.exit(2);",
        "  }",
        '  if (process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER === "1" && !seenFastServiceTier) {',
        '    process.stderr.write("missing fast service tier config\\n");',
        "    process.exit(5);",
        "  }",
        "  if (process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT) {",
        '    const normalizedSeenReasoningEffort = seenReasoningEffort.replaceAll(\'"\', "");',
        "    const expectedReasoningEffort = `model_reasoning_effort=${process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT}`;",
        "    if (normalizedSeenReasoningEffort !== expectedReasoningEffort) {",
        "      process.stderr.write(`unexpected reasoning effort config: ${seenReasoningEffort}\\n`);",
        "      process.exit(6);",
        "    }",
        "  }",
        '  if (process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT === "1" && seenReasoningEffort.length > 0) {',
        "    process.stderr.write(`reasoning effort config should be omitted: ${seenReasoningEffort}\\n`);",
        "    process.exit(7);",
        "  }",
        "  if (process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN && !stdinContent.includes(process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN)) {",
        '    process.stderr.write("stdin missing expected content\\n");',
        "    process.exit(3);",
        "  }",
        "  if (process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN && stdinContent.includes(process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN)) {",
        '    process.stderr.write("stdin contained forbidden content\\n");',
        "    process.exit(4);",
        "  }",
        "  if (process.env.T3_FAKE_CODEX_STDERR) {",
        "    process.stderr.write(`${process.env.T3_FAKE_CODEX_STDERR}\\n`);",
        "  }",
        "  if (outputPath) {",
        '    fs.writeFileSync(outputPath, Buffer.from(process.env.T3_FAKE_CODEX_OUTPUT_B64 ?? "e30=", "base64"));',
        "  }",
        '  process.exit(Number(process.env.T3_FAKE_CODEX_EXIT_CODE ?? "0"));',
        "});",
        "process.stdin.resume();",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(codexPath, ["#!/bin/sh", 'exec node "$0.cjs" "$@"', ""].join("\n"));
    yield* fs.chmod(codexPath, 0o755);
    yield* fs.writeFileString(
      codexCmdPath,
      ["@echo off", 'node "%~dp0codex.cjs" %*', ""].join("\r\n"),
    );
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousOutput = process.env.T3_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.T3_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.T3_FAKE_CODEX_STDERR;
      const previousRequireImage = process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
      const previousRequireFastServiceTier = process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
      const previousRequireReasoningEffort = process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
      const previousForbidReasoningEffort = process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
      const previousStdinMustContain = process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}${nodePath.delimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString("base64");

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CODEX_STDERR;
        }

        if (input.requireImage) {
          process.env.T3_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.requireFastServiceTier) {
          process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
        }

        if (input.requireReasoningEffort !== undefined) {
          process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT = input.requireReasoningEffort;
        } else {
          delete process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
        }

        if (input.forbidReasoningEffort) {
          process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT = "1";
        } else {
          delete process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousRequireFastServiceTier,
        previousRequireReasoningEffort,
        previousForbidReasoningEffort,
        previousStdinMustContain,
        previousStdinMustNotContain,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;

        if (previous.previousOutput === undefined) {
          delete process.env.T3_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.T3_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.T3_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.T3_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.T3_FAKE_CODEX_STDERR;
        } else {
          process.env.T3_FAKE_CODEX_STDERR = previous.previousStderr;
        }

        if (previous.previousRequireImage === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousRequireFastServiceTier === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_FAST_SERVICE_TIER =
            previous.previousRequireFastServiceTier;
        }

        if (previous.previousRequireReasoningEffort === undefined) {
          delete process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT;
        } else {
          process.env.T3_FAKE_CODEX_REQUIRE_REASONING_EFFORT =
            previous.previousRequireReasoningEffort;
        }

        if (previous.previousForbidReasoningEffort === undefined) {
          delete process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT;
        } else {
          process.env.T3_FAKE_CODEX_FORBID_REASONING_EFFORT =
            previous.previousForbidReasoningEffort;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.T3_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.T3_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = previous.previousStdinMustNotContain;
        }
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
              },
            },
          });
        }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateBranchName({
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          cwd: process.cwd(),
          message: "Fix layout bug from screenshot.",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        });

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("Codex returned invalid structured output");
          }
        }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain(
            "Codex CLI command failed: codex execution failed",
          );
        }
      }),
    ),
  );
});
