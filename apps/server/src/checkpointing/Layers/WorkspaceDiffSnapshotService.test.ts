import { CheckpointRef } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { WorkspaceDiffSnapshotService } from "../Services/WorkspaceDiffSnapshotService.ts";
import { WorkspaceDiffSnapshotServiceLive } from "./WorkspaceDiffSnapshotService.ts";

describe("WorkspaceDiffSnapshotServiceLive", () => {
  it("coalesces matching live diff requests", async () => {
    let calls = 0;
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointToWorkspace: () =>
        Effect.gen(function* () {
          calls += 1;
          yield* Effect.sleep("20 millis");
          return {
            diff: [
              "diff --git a/live.txt b/live.txt",
              "index 1111111..2222222 100644",
              "--- a/live.txt",
              "+++ b/live.txt",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
            truncated: false,
          };
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = WorkspaceDiffSnapshotServiceLive.pipe(
      Layer.provide(Layer.succeed(CheckpointStore, checkpointStore)),
    );

    const [left, right] = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkspaceDiffSnapshotService;
        const input = {
          cwd: "/tmp/workspace",
          fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/turn/1"),
          ignoreWhitespace: true,
          scope: { type: "workspace" as const },
        };
        return yield* Effect.all([service.getLiveTurnDiff(input), service.getLiveTurnDiff(input)], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(calls).toBe(1);
    expect(left.diff).toEqual(right.diff);
    expect(left.diff).toContain("diff --git a/live.txt b/live.txt");
  });
});
