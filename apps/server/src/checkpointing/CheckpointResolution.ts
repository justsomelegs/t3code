import type { CheckpointRef, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionThreadCheckpointContext } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CheckpointStoreShape } from "./Services/CheckpointStore.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "./Errors.ts";
import { isRealCheckpointRef } from "./CheckpointRefs.ts";

export interface ResolvedThreadCheckpointContext extends ProjectionThreadCheckpointContext {
  readonly workspaceCwd: string;
}

export const resolveThreadCheckpointContext = Effect.fn("resolveThreadCheckpointContext")(
  function* (input: {
    readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    const context = yield* input.projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(context)) {
      return yield* new CheckpointInvariantError({
        operation: input.operation,
        detail: `Thread '${input.threadId}' not found.`,
      });
    }

    const workspaceCwd = context.value.worktreePath ?? context.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointInvariantError({
        operation: input.operation,
        detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
      });
    }

    return {
      ...context.value,
      workspaceCwd,
    } satisfies ResolvedThreadCheckpointContext;
  },
);

export const requireRealCheckpointRef = Effect.fn("requireRealCheckpointRef")(function* (input: {
  readonly checkpointStore: CheckpointStoreShape;
  readonly checkpointRef: CheckpointRef | undefined;
  readonly threadId: ThreadId;
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

  const exists = yield* input.checkpointStore.hasCheckpointRef({
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
});
