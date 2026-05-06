import {
  CheckpointRef,
  OrchestrationGetTurnDiffViewResult,
  type OrchestrationCheckpointSummary,
  type OrchestrationGetTurnDiffViewResult as OrchestrationGetTurnDiffViewResultType,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { normalizeUnifiedDiffToTurnDiffFiles } from "../Diffs.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { TurnDiffService, type TurnDiffServiceShape } from "../Services/TurnDiffService.ts";
import { WorkspaceDiffSnapshotService } from "../Services/WorkspaceDiffSnapshotService.ts";
import { isRealCheckpointRef } from "../CheckpointRefs.ts";

const isTurnDiffViewResult = Schema.is(OrchestrationGetTurnDiffViewResult);

function makeRevision(input: {
  readonly mode: "completed" | "live";
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef?: CheckpointRef;
  readonly filesHash: string;
}) {
  return [
    input.mode,
    input.fromCheckpointRef,
    input.toCheckpointRef ?? "workspace",
    input.filesHash,
  ].join(":");
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
  const workspaceDiffSnapshotService = yield* WorkspaceDiffSnapshotService;

  const resolveThreadContext = Effect.fn("TurnDiffService.resolveThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(threadId);
    if (Option.isNone(context)) {
      return yield* new CheckpointInvariantError({
        operation: "TurnDiffService.resolveThreadContext",
        detail: `Thread '${threadId}' not found.`,
      });
    }
    const workspaceCwd = context.value.worktreePath ?? context.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointInvariantError({
        operation: "TurnDiffService.resolveThreadContext",
        detail: `Workspace path missing for thread '${threadId}' when computing turn diff.`,
      });
    }
    return { ...context.value, workspaceCwd };
  });

  const requireRealCheckpoint = Effect.fn("TurnDiffService.requireRealCheckpoint")(
    function* (input: {
      readonly checkpointRef: CheckpointRef | undefined;
      readonly threadId: string;
      readonly turnCount: number;
      readonly cwd: string;
    }) {
      if (!input.checkpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.turnCount}.`,
        });
      }
      if (!isRealCheckpointRef(input.checkpointRef)) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: `Turn ${input.turnCount} is a legacy diff summary without a filesystem checkpoint.`,
        });
      }
      const exists = yield* checkpointStore.hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: input.checkpointRef,
      });
      if (!exists) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.turnCount}.`,
        });
      }
      return input.checkpointRef;
    },
  );

  const getTurnDiffView: TurnDiffServiceShape["getTurnDiffView"] = Effect.fn("getTurnDiffView")(
    function* (input) {
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      const context = yield* resolveThreadContext(input.threadId);
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
      const fromRef = yield* requireRealCheckpoint({
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
              const toRef = yield* requireRealCheckpoint({
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
              });
              return {
                files: normalizeUnifiedDiffToTurnDiffFiles(diff),
                truncated: false,
                toCheckpointRef: toRef,
              };
            })
          : yield* workspaceDiffSnapshotService
              .getLiveTurnDiff({
                cwd: context.workspaceCwd,
                fromCheckpointRef: fromRef,
                ignoreWhitespace,
                scope: input.scope ?? { type: "workspace" },
              })
              .pipe(
                Effect.map((result) => ({
                  files: result.files,
                  truncated: result.truncated,
                  toCheckpointRef: undefined,
                })),
              );

      const files = viewResult.files;
      const turnDiffView: OrchestrationGetTurnDiffViewResultType = {
        threadId: input.threadId,
        turnId: input.turnId,
        mode: input.mode,
        revision: makeRevision({
          mode: input.mode,
          fromCheckpointRef: fromRef,
          ...(viewResult.toCheckpointRef ? { toCheckpointRef: viewResult.toCheckpointRef } : {}),
          filesHash: files.map((file) => file.hash).join(".") || "empty",
        }),
        files,
        truncated: viewResult.truncated,
      };

      if (!isTurnDiffViewResult(turnDiffView)) {
        return yield* new CheckpointInvariantError({
          operation: "TurnDiffService.getTurnDiffView",
          detail: "Computed turn diff view does not satisfy contract schema.",
        });
      }
      return turnDiffView;
    },
  );

  return {
    getTurnDiffView,
  } satisfies TurnDiffServiceShape;
});

export const TurnDiffServiceLive = Layer.effect(TurnDiffService, make);
