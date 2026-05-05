import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { TurnDiffService } from "../Services/TurnDiffService.ts";
import { TurnDiffServiceLive } from "./TurnDiffService.ts";

function makeContext(input: {
  readonly threadId: ThreadId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly turnId?: TurnId;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: ProjectId.make("project-1"),
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    checkpoints: [
      {
        turnId: input.turnId ?? TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeProjectionLayer(context: ProjectionThreadCheckpointContext) {
  return Layer.succeed(ProjectionSnapshotQuery, {
    getSnapshot: () => Effect.die("TurnDiffService should not request the full snapshot"),
    getShellSnapshot: () => Effect.die("TurnDiffService should not request the shell snapshot"),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  });
}

describe("TurnDiffServiceLive", () => {
  it("reads completed turn diffs from baseline checkpoint to completed checkpoint", async () => {
    const threadId = ThreadId.make("thread-completed-diff-view");
    const turnId = TurnId.make("turn-1");
    const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
    }> = [];
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef });
          return [
            "diff --git a/file.txt b/file.txt",
            "index 1111111..2222222 100644",
            "--- a/file.txt",
            "+++ b/file.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n");
        }),
      diffCheckpointToWorkspace: () => Effect.succeed({ diff: "", truncated: false }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = TurnDiffServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        makeProjectionLayer(
          makeContext({ threadId, turnId, checkpointTurnCount: 1, checkpointRef: toCheckpointRef }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TurnDiffService;
        return yield* service.getTurnDiffView({
          threadId,
          turnId,
          mode: "completed",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ fromCheckpointRef, toCheckpointRef }]);
    expect(result.files).toMatchObject([
      {
        path: "file.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(result.mode).toBe("completed");
  });

  it("reads live diffs from the latest checkpoint to the workspace snapshot", async () => {
    const threadId = ThreadId.make("thread-live-diff-view");
    const completedTurnId = TurnId.make("turn-1");
    const liveTurnId = TurnId.make("turn-2");
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const liveCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly paths?: string[];
    }> = [];
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointToWorkspace: ({ fromCheckpointRef, paths }) =>
        Effect.sync(() => {
          liveCalls.push({
            fromCheckpointRef,
            ...(paths ? { paths: [...paths] } : {}),
          });
          return {
            diff: [
              "diff --git a/live.txt b/live.txt",
              "new file mode 100644",
              "index 0000000..2222222",
              "--- /dev/null",
              "+++ b/live.txt",
              "@@ -0,0 +1 @@",
              "+live",
            ].join("\n"),
            truncated: false,
          };
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = TurnDiffServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        makeProjectionLayer(
          makeContext({
            threadId,
            turnId: completedTurnId,
            checkpointTurnCount: 1,
            checkpointRef: baselineCheckpointRef,
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TurnDiffService;
        return yield* service.getTurnDiffView({
          threadId,
          turnId: liveTurnId,
          mode: "live",
          paths: ["live.txt"],
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(liveCalls).toEqual([{ fromCheckpointRef: baselineCheckpointRef, paths: ["live.txt"] }]);
    expect(result.files).toMatchObject([
      {
        path: "live.txt",
        status: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(result.mode).toBe("live");
  });
});
