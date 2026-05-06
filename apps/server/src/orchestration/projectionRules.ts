import type {
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationTurnCheckpointState,
  OrchestrationTurnLifecycleState,
  TurnId,
} from "@t3tools/contracts";

export {
  isLegacyProviderDiffCheckpoint,
  isRealCheckpointRef,
} from "../checkpointing/CheckpointRefs.ts";

interface TurnStateSetProjectionPayload {
  readonly turnId: TurnId;
  readonly state: OrchestrationTurnLifecycleState;
  readonly requestedAt: string | undefined;
  readonly startedAt: string | null | undefined;
  readonly completedAt: string | null | undefined;
  readonly assistantMessageId: MessageId | null | undefined;
}

export function checkpointStatusToLatestTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationTurnLifecycleState {
  return status === "error" ? "error" : "completed";
}

export function checkpointStatusToCaptureState(
  status: "ready" | "missing" | "error",
): OrchestrationTurnCheckpointState {
  switch (status) {
    case "ready":
      return "ready";
    case "missing":
      return "unavailable";
    case "error":
      return "error";
  }
}

export function reduceLatestTurnState(input: {
  readonly previous: OrchestrationLatestTurn | null;
  readonly payload: TurnStateSetProjectionPayload;
  readonly occurredAt: string;
}): OrchestrationLatestTurn {
  const previous = input.previous;
  const sameTurn = previous?.turnId === input.payload.turnId;
  return {
    turnId: input.payload.turnId,
    state: input.payload.state,
    requestedAt: input.payload.requestedAt ?? (sameTurn ? previous!.requestedAt : input.occurredAt),
    startedAt: input.payload.startedAt ?? (sameTurn ? previous!.startedAt : input.occurredAt),
    completedAt: input.payload.completedAt ?? null,
    assistantMessageId:
      input.payload.assistantMessageId ?? (sameTurn ? previous!.assistantMessageId : null),
    checkpointState: sameTurn ? (previous!.checkpointState ?? "not-started") : "not-started",
    ...(sameTurn && previous!.sourceProposedPlan
      ? { sourceProposedPlan: previous!.sourceProposedPlan }
      : {}),
  };
}

export function withLatestTurnCheckpointState(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly turnId: string;
  readonly checkpointState: OrchestrationTurnCheckpointState;
}): OrchestrationLatestTurn | null {
  if (!input.latestTurn || input.latestTurn.turnId !== input.turnId) {
    return input.latestTurn;
  }
  return {
    ...input.latestTurn,
    checkpointState: input.checkpointState,
  };
}
