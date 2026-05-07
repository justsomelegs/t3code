import assert from "node:assert/strict";
import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  isWindowsCommandNotFound,
  runProcess as runCurrentProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../src/processRunner.ts";

const tinyIterations = Number.parseInt(Bun.argv[2] ?? "40", 10);
const mediumIterations = Number.parseInt(Bun.argv[3] ?? "15", 10);
const largeIterations = Number.parseInt(Bun.argv[4] ?? "8", 10);
const warmupIterations = Number.parseInt(Bun.argv[5] ?? "3", 10);

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function percentile(sortedSamples: number[], ratio: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil(sortedSamples.length * ratio) - 1),
  );
  return sortedSamples[index] ?? 0;
}

function summarize(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations: samples.length,
    meanMs: Number((total / samples.length).toFixed(2)),
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
  };
}

async function benchmark(iterations: number, run: () => Promise<void>) {
  const samples: number[] = [];

  for (let index = 0; index < warmupIterations; index += 1) {
    await run();
  }

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }

  return summarize(samples);
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
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

interface CollectedTextState {
  readonly decoder: TextDecoder;
  readonly mode: "parts" | "concat";
  readonly parts: Array<string>;
  text: string;
  bytes: number;
  truncated: boolean;
}

function appendCollectedChunkInPlace(
  state: CollectedTextState,
  chunk: Buffer | string,
  maxBytes: number,
  outputMode: "error" | "truncate",
) {
  if (state.truncated && outputMode === "truncate") {
    return;
  }

  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const remainingBytes = maxBytes - state.bytes;

  if (remainingBytes <= 0) {
    if (outputMode === "truncate") {
      state.truncated = true;
      return;
    }

    state.bytes += bytes.byteLength;
    return;
  }

  const nextChunk =
    outputMode === "truncate" && bytes.byteLength > remainingBytes
      ? bytes.subarray(0, remainingBytes)
      : bytes;
  const nextPart = state.decoder.decode(nextChunk, { stream: true });
  if (nextPart.length > 0) {
    if (state.mode === "parts") {
      state.parts.push(nextPart);
    } else {
      state.text += nextPart;
    }
  }
  state.bytes += nextChunk.byteLength;
  state.truncated = outputMode === "truncate" && bytes.byteLength > remainingBytes;
}

function finalizeCollectedText(state: CollectedTextState): {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} {
  return {
    text:
      state.mode === "parts"
        ? state.truncated
          ? state.parts.join("")
          : `${state.parts.join("")}${state.decoder.decode()}`
        : state.truncated
          ? state.text
          : `${state.text}${state.decoder.decode()}`,
    bytes: state.bytes,
    truncated: state.truncated,
  };
}

interface CollectedProcessCoreOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly allowNonZeroExit: boolean;
  readonly maxBufferBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly collectorMode: "parts" | "concat";
  readonly shell: boolean;
  readonly normalizeSpawnError: (error: unknown) => Error;
  readonly normalizeExitError: (result: ProcessRunResult) => Error;
  readonly normalizeStdinError: (error: unknown) => Error;
  readonly normalizeBufferError: (stream: "stdout" | "stderr", maxBytes: number) => Error;
}

async function runCollectedProcessCore(
  command: string,
  args: readonly string[],
  options: CollectedProcessCoreOptions,
): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: options.shell,
    });

    let stdoutState: CollectedTextState = {
      decoder: new TextDecoder(),
      mode: options.collectorMode,
      parts: [],
      text: "",
      bytes: 0,
      truncated: false,
    };
    let stderrState: CollectedTextState = {
      decoder: new TextDecoder(),
      mode: options.collectorMode,
      parts: [],
      text: "",
      bytes: 0,
      truncated: false,
    };
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    }, options.timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: Error): void => {
      killChild(child, "SIGTERM");
      finalize(() => reject(error));
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      if (stream === "stdout") {
        appendCollectedChunkInPlace(stdoutState, chunk, options.maxBufferBytes, options.outputMode);
        if (options.outputMode === "error" && stdoutState.bytes > options.maxBufferBytes) {
          return options.normalizeBufferError("stdout", options.maxBufferBytes);
        }
        return null;
      }

      appendCollectedChunkInPlace(stderrState, chunk, options.maxBufferBytes, options.outputMode);
      if (options.outputMode === "error" && stderrState.bytes > options.maxBufferBytes) {
        return options.normalizeBufferError("stderr", options.maxBufferBytes);
      }
      return null;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => reject(options.normalizeSpawnError(error)));
    });

    child.once("close", (code, signal) => {
      const stdout = finalizeCollectedText(stdoutState);
      const stderr = finalizeCollectedText(stderrState);
      const result: ProcessRunResult = {
        stdout: stdout.text,
        stderr: stderr.text,
        code,
        signal,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };

      finalize(() => {
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(options.normalizeExitError(result));
          return;
        }
        resolve(result);
      });
    });

    child.stdin?.once("error", (error) => {
      fail(options.normalizeStdinError(error));
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin, (error) => {
        if (error) {
          fail(options.normalizeStdinError(error));
          return;
        }
        child.stdin?.end();
      });
      return;
    }

    child.stdin?.end();
  });
}

async function runPrototypeProcessRunner(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
  collectorMode: "parts" | "concat" = "parts",
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return runCollectedProcessCore(command, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    timeoutMs,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    allowNonZeroExit: options.allowNonZeroExit ?? false,
    maxBufferBytes,
    outputMode,
    collectorMode,
    shell: process.platform === "win32",
    normalizeSpawnError: (error) => normalizeSpawnError(command, args, error),
    normalizeExitError: (result) => normalizeExitError(command, args, result),
    normalizeStdinError: (error) => normalizeStdinError(command, args, error),
    normalizeBufferError: (stream, limit) => normalizeBufferError(command, args, stream, limit),
  });
}

const runPrototypeProcessRunnerParts: Runner = (command, args, options) =>
  runPrototypeProcessRunner(command, args, options, "parts");

const runPrototypeProcessRunnerConcat: Runner = (command, args, options) =>
  runPrototypeProcessRunner(command, args, options, "concat");

type Runner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

async function expectThrows(label: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run();
    throw new Error(`${label} unexpectedly succeeded.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern, `${label} threw an unexpected error: ${message}`);
  }
}

async function runBehaviorChecks(runner: Runner, label: string) {
  const helperScriptPath = makeHelperScript();

  const truncation = await runner("node", [helperScriptPath, "stdout-bytes", "2048"], {
    maxBufferBytes: 128,
    outputMode: "truncate",
  });
  assert.equal(truncation.code, 0, `${label} truncate exit code mismatch`);
  assert.equal(truncation.stdoutTruncated, true, `${label} should truncate stdout`);
  assert.equal(truncation.stderrTruncated, false, `${label} should not truncate stderr`);
  assert.equal(truncation.stdout.length <= 128, true, `${label} truncate length mismatch`);

  const stdinResult = await runner("node", [helperScriptPath, "stdin-echo"], {
    stdin: "prototype-stdin",
  });
  assert.equal(stdinResult.stdout, "prototype-stdin", `${label} stdin roundtrip mismatch`);

  const nonZeroAllowed = await runner("node", [helperScriptPath, "stderr-exit", "warn", "3"], {
    allowNonZeroExit: true,
  });
  assert.equal(nonZeroAllowed.code, 3, `${label} non-zero exit code mismatch`);
  assert.equal(nonZeroAllowed.stderr, "warn", `${label} stderr mismatch`);

  await expectThrows(
    `${label} buffer overflow`,
    () =>
      runner("node", [helperScriptPath, "stdout-bytes", "2048"], {
        maxBufferBytes: 128,
      }),
    /exceeded stdout buffer limit/i,
  );

  await expectThrows(
    `${label} timeout`,
    () =>
      runner("node", [helperScriptPath, "sleep-stdout", "200", "late"], {
        timeoutMs: 50,
      }),
    /timed out/i,
  );

  cleanupHelperScript(helperScriptPath);
}

interface Scenario {
  readonly name: string;
  readonly iterations: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: ProcessRunOptions;
}

function makeHelperScript(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "t3-process-runner-proto-"));
  const helperPath = path.join(directory, "helper.js");
  writeFileSync(
    helperPath,
    [
      "const mode = process.argv[2];",
      "if (mode === 'stdout-bytes') {",
      "  process.stdout.write('x'.repeat(Number(process.argv[3] ?? '0')));",
      "} else if (mode === 'stderr-bytes') {",
      "  process.stderr.write('x'.repeat(Number(process.argv[3] ?? '0')));",
      "} else if (mode === 'stderr-exit') {",
      "  process.stderr.write(process.argv[3] ?? '');",
      "  process.exit(Number(process.argv[4] ?? '0'));",
      "} else if (mode === 'stdin-echo') {",
      "  process.stdin.setEncoding('utf8');",
      "  let data = '';",
      "  process.stdin.on('data', (chunk) => { data += chunk; });",
      "  process.stdin.on('end', () => { process.stdout.write(data); });",
      "} else if (mode === 'sleep-stdout') {",
      "  setTimeout(() => process.stdout.write(process.argv[4] ?? ''), Number(process.argv[3] ?? '0'));",
      "} else if (mode === 'stdout-text') {",
      "  process.stdout.write(process.argv[3] ?? '');",
      "} else if (mode === 'stderr-text') {",
      "  process.stderr.write(process.argv[3] ?? '');",
      "} else {",
      "  process.exit(2);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return helperPath;
}

function cleanupHelperScript(helperPath: string) {
  rmSync(path.dirname(helperPath), { recursive: true, force: true });
}

async function main() {
  const helperScriptPath = makeHelperScript();

  await runBehaviorChecks(runCurrentProcessRunner, "current");
  await runBehaviorChecks(runPrototypeProcessRunnerParts, "prototypeParts");
  await runBehaviorChecks(runPrototypeProcessRunnerConcat, "prototypeConcat");

  const scenarios: ReadonlyArray<Scenario> = [
    {
      name: "tiny_stdout",
      iterations: tinyIterations,
      command: "node",
      args: [helperScriptPath, "stdout-text", "ok"],
    },
    {
      name: "tiny_stderr",
      iterations: tinyIterations,
      command: "node",
      args: [helperScriptPath, "stderr-text", "warn"],
    },
    {
      name: "stdin_roundtrip_4kb",
      iterations: tinyIterations,
      command: "node",
      args: [helperScriptPath, "stdin-echo"],
      options: {
        stdin: "x".repeat(4 * 1024),
      },
    },
    {
      name: "stdout_2mb",
      iterations: mediumIterations,
      command: "node",
      args: [helperScriptPath, "stdout-bytes", String(2 * 1024 * 1024)],
    },
    {
      name: "stdout_20mb_truncate_8mb",
      iterations: largeIterations,
      command: "node",
      args: [helperScriptPath, "stdout-bytes", String(20 * 1024 * 1024)],
      options: {
        maxBufferBytes: 8 * 1024 * 1024,
        outputMode: "truncate",
      },
    },
  ];

  const results: Record<
    string,
    {
      readonly current: ReturnType<typeof summarize>;
      readonly prototypeConcat: ReturnType<typeof summarize>;
      readonly prototypeParts: ReturnType<typeof summarize>;
      readonly concatMeanDeltaMs: number;
      readonly concatMeanDeltaPercent: number;
      readonly concatP99DeltaMs: number;
      readonly concatP99DeltaPercent: number;
      readonly partsMeanDeltaMs: number;
      readonly partsMeanDeltaPercent: number;
      readonly partsP99DeltaMs: number;
      readonly partsP99DeltaPercent: number;
    }
  > = {};

  for (const scenario of scenarios) {
    const current = await benchmark(scenario.iterations, () =>
      runCurrentProcessRunner(scenario.command, scenario.args, scenario.options).then(
        () => undefined,
      ),
    );
    const prototypeConcat = await benchmark(scenario.iterations, () =>
      runPrototypeProcessRunnerConcat(scenario.command, scenario.args, scenario.options).then(
        () => undefined,
      ),
    );
    const prototypeParts = await benchmark(scenario.iterations, () =>
      runPrototypeProcessRunnerParts(scenario.command, scenario.args, scenario.options).then(
        () => undefined,
      ),
    );

    results[scenario.name] = {
      current,
      prototypeConcat,
      prototypeParts,
      concatMeanDeltaMs: Number((prototypeConcat.meanMs - current.meanMs).toFixed(2)),
      concatMeanDeltaPercent: Number(
        (((prototypeConcat.meanMs - current.meanMs) / current.meanMs) * 100).toFixed(2),
      ),
      concatP99DeltaMs: Number((prototypeConcat.p99Ms - current.p99Ms).toFixed(2)),
      concatP99DeltaPercent: Number(
        (((prototypeConcat.p99Ms - current.p99Ms) / current.p99Ms) * 100).toFixed(2),
      ),
      partsMeanDeltaMs: Number((prototypeParts.meanMs - current.meanMs).toFixed(2)),
      partsMeanDeltaPercent: Number(
        (((prototypeParts.meanMs - current.meanMs) / current.meanMs) * 100).toFixed(2),
      ),
      partsP99DeltaMs: Number((prototypeParts.p99Ms - current.p99Ms).toFixed(2)),
      partsP99DeltaPercent: Number(
        (((prototypeParts.p99Ms - current.p99Ms) / current.p99Ms) * 100).toFixed(2),
      ),
    };
  }

  console.log(
    JSON.stringify(
      {
        warmupIterations,
        scenarios: scenarios.map((scenario) => ({
          name: scenario.name,
          iterations: scenario.iterations,
          options:
            scenario.options === undefined
              ? {}
              : {
                  ...(scenario.options.maxBufferBytes !== undefined
                    ? { maxBufferBytes: scenario.options.maxBufferBytes }
                    : {}),
                  ...(scenario.options.outputMode !== undefined
                    ? { outputMode: scenario.options.outputMode }
                    : {}),
                  ...(scenario.options.stdin !== undefined
                    ? { stdinBytes: Buffer.byteLength(scenario.options.stdin, "utf8") }
                    : {}),
                },
        })),
        results,
      },
      null,
      2,
    ),
  );

  cleanupHelperScript(helperScriptPath);
}

await main();
