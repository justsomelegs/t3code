import { afterAll, describe, expect, it } from "vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";

import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

const runtime = ManagedRuntime.make(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)));

afterAll(async () => {
  await runtime.dispose();
});

async function run(input: VcsProcess.VcsProcessInput) {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      return yield* process.run(input);
    }),
  );
}

describe("VcsProcess.run", () => {
  it("collects stdout", async () => {
    const result = await run({
      operation: "test.stdout",
      command: "node",
      args: ["-e", "process.stdout.write('hello')"],
      cwd: process.cwd(),
    });

    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it("writes stdin before waiting for exit", async () => {
    const result = await run({
      operation: "test.stdin",
      command: "node",
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let data='';",
          "process.stdin.on('data', chunk => { data += chunk; });",
          "process.stdin.on('end', () => { process.stdout.write(data); });",
        ].join(""),
      ],
      cwd: process.cwd(),
      stdin: "stdin payload",
    });

    expect(result.stdout).toBe("stdin payload");
  });

  it("fails with VcsProcessExitError for non-zero exits by default", async () => {
    await expect(
      run({
        operation: "test.exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
      }),
    ).rejects.toBeInstanceOf(VcsProcessExitError);
  });

  it("returns output when non-zero exits are allowed", async () => {
    const result = await run({
      operation: "test.allowed-exit",
      command: "node",
      args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
      cwd: process.cwd(),
      allowNonZeroExit: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("truncates output and appends the marker when requested", async () => {
    const result = await run({
      operation: "test.truncate-marker",
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: process.cwd(),
      maxOutputBytes: 128,
      appendTruncationMarker: true,
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain("[truncated]");
    expect(result.stderrTruncated).toBe(false);
  });

  it("truncates without the marker when truncation markers are disabled", async () => {
    const result = await run({
      operation: "test.truncate-silent",
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: process.cwd(),
      maxOutputBytes: 128,
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("[truncated]");
  });

  it("fails with VcsProcessTimeoutError on timeout", async () => {
    await expect(
      run({
        operation: "test.timeout",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: process.cwd(),
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(VcsProcessTimeoutError);
  });
});
