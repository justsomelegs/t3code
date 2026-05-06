import { createHash } from "node:crypto";

import {
  CheckpointRef,
  type OrchestrationCheckpointSummary,
  type OrchestrationGetTurnDiffViewResult,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointUnavailableError } from "../Errors.ts";
import {
  requireRealCheckpointRef,
  resolveThreadCheckpointContext,
} from "../CheckpointResolution.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { TurnDiffService, type TurnDiffServiceShape } from "../Services/TurnDiffService.ts";
import { isRealCheckpointRef } from "../CheckpointRefs.ts";

function makeRevision(input: {
  readonly mode: "completed" | "live";
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef?: CheckpointRef;
  readonly diffHash: string;
}) {
  return [
    input.mode,
    input.fromCheckpointRef,
    input.toCheckpointRef ?? "workspace",
    input.diffHash,
  ].join(":");
}

function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function previousRealCheckpointBefore(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnCount: number,
): OrchestrationCheckpointSummary | undefined {
  return checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.checkpointTurnCount < turnCount && isRealCheckpointRef(checkpoint.checkpointRef),
    )
    .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0];
}

function latestRealCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): OrchestrationCheckpointSummary | undefined {
  return checkpoints
    .filter((checkpoint) => isRealCheckpointRef(checkpoint.checkpointRef))
    .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0];
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiffView: TurnDiffServiceShape["getTurnDiffView"] = Effect.fn("getTurnDiffView")(
    function* (input) {
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      const context = yield* resolveThreadCheckpointContext({
        projectionSnapshotQuery,
        threadId: input.threadId,
        operation: "TurnDiffService.resolveThreadContext",
      });
      const targetCheckpoint = context.checkpoints.find(
        (checkpoint) => checkpoint.turnId === input.turnId,
      );

      const baselineCheckpoint =
        input.mode === "completed" && targetCheckpoint
          ? previousRealCheckpointBefore(context.checkpoints, targetCheckpoint.checkpointTurnCount)
          : latestRealCheckpoint(context.checkpoints);
      const baselineTurnCount = baselineCheckpoint?.checkpointTurnCount ?? 0;
      const fromCheckpointRef =
        baselineCheckpoint?.checkpointRef ?? checkpointRefForThreadTurn(input.threadId, 0);
      const fromRef = yield* requireRealCheckpointRef({
        checkpointStore,
        checkpointRef: fromCheckpointRef,
        threadId: input.threadId,
        turnCount: baselineTurnCount,
        cwd: context.workspaceCwd,
      });

      const viewResult =
        input.mode === "completed"
          ? yield* Effect.gen(function* () {
              if (!targetCheckpoint) {
                return yield* new CheckpointUnavailableError({
                  threadId: input.threadId,
                  turnCount: baselineTurnCount + 1,
                  detail: `Checkpoint ref is unavailable for turn '${input.turnId}'.`,
                });
              }
              const toRef = yield* requireRealCheckpointRef({
                checkpointStore,
                checkpointRef: targetCheckpoint.checkpointRef,
                threadId: input.threadId,
                turnCount: targetCheckpoint.checkpointTurnCount,
                cwd: context.workspaceCwd,
              });
              const diff = yield* checkpointStore.diffCheckpoints({
                cwd: context.workspaceCwd,
                fromCheckpointRef: fromRef,
                toCheckpointRef: toRef,
                fallbackFromToHead: false,
                ignoreWhitespace,
                ...(input.scope ? { scope: input.scope } : {}),
              });
              return {
                diff,
                truncated: false,
                toCheckpointRef: toRef,
              };
            })
          : yield* checkpointStore
              .diffCheckpointToWorkspace({
                cwd: context.workspaceCwd,
                fromCheckpointRef: fromRef,
                ignoreWhitespace,
                scope: input.scope ?? { type: "workspace" },
              })
              .pipe(
                Effect.map((result) => ({
                  diff: result.diff,
                  truncated: result.truncated,
                  toCheckpointRef: undefined,
                })),
              );

      const turnDiffView: OrchestrationGetTurnDiffViewResult = {
        threadId: input.threadId,
        turnId: input.turnId,
        mode: input.mode,
        revision: makeRevision({
          mode: input.mode,
          fromCheckpointRef: fromRef,
          ...(viewResult.toCheckpointRef ? { toCheckpointRef: viewResult.toCheckpointRef } : {}),
          diffHash: hashDiff(viewResult.diff),
        }),
        diff: viewResult.diff,
        truncated: viewResult.truncated,
      };
      return turnDiffView;
    },
  );

  return {
    getTurnDiffView,
  } satisfies TurnDiffServiceShape;
});

export const TurnDiffServiceLive = Layer.effect(TurnDiffService, make);
