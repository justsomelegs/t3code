import {
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult,
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
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResult = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        return emptyDiff;
      }

      const threadContext = yield* resolveThreadCheckpointContext({
        projectionSnapshotQuery,
        threadId: input.threadId,
        operation,
      });

      const maxTurnCount = threadContext.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      const toCheckpointRef = threadContext.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      const [fromRef, toRef] = yield* Effect.all(
        [
          requireRealCheckpointRef({
            checkpointStore,
            checkpointRef: fromCheckpointRef,
            threadId: input.threadId,
            turnCount: input.fromTurnCount,
            cwd: threadContext.workspaceCwd,
          }),
          requireRealCheckpointRef({
            checkpointStore,
            checkpointRef: toCheckpointRef,
            threadId: input.threadId,
            turnCount: input.toTurnCount,
            cwd: threadContext.workspaceCwd,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: threadContext.workspaceCwd,
        fromCheckpointRef: fromRef,
        toCheckpointRef: toRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const turnDiff: OrchestrationGetTurnDiffResult = {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace: input.ignoreWhitespace ?? true,
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
