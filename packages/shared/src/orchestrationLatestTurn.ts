import type {
  MessageId,
  OrchestrationCheckpointStatus,
  OrchestrationLatestTurn,
  OrchestrationTurnCheckpointState,
  OrchestrationTurnLifecycleState,
  TurnId,
} from "@t3tools/contracts";

export function checkpointStatusToLatestTurnState(
  status: OrchestrationCheckpointStatus,
): OrchestrationTurnLifecycleState {
  return status === "error" ? "error" : "completed";
}

export function checkpointStatusToCaptureState(
  status: OrchestrationCheckpointStatus,
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

export function buildLatestTurn(input: {
  readonly previous: OrchestrationLatestTurn | null;
  readonly turnId: TurnId;
  readonly state: OrchestrationTurnLifecycleState;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly checkpointState?: OrchestrationTurnCheckpointState;
  readonly sourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}): OrchestrationLatestTurn {
  const sameTurn = input.previous?.turnId === input.turnId;
  const sourceProposedPlan = sameTurn
    ? input.previous?.sourceProposedPlan
    : input.sourceProposedPlan;

  return {
    turnId: input.turnId,
    state: input.state,
    requestedAt: input.requestedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    assistantMessageId: input.assistantMessageId,
    checkpointState:
      input.checkpointState ??
      (sameTurn ? (input.previous?.checkpointState ?? "not-started") : "not-started"),
    ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
  };
}

export function reduceLatestTurnState(input: {
  readonly previous: OrchestrationLatestTurn | null;
  readonly payload: {
    readonly turnId: TurnId;
    readonly state: OrchestrationTurnLifecycleState;
    readonly requestedAt: string | undefined;
    readonly startedAt: string | null | undefined;
    readonly completedAt: string | null | undefined;
    readonly assistantMessageId: MessageId | null | undefined;
  };
  readonly occurredAt: string;
  readonly sourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}): OrchestrationLatestTurn {
  const sameTurn = input.previous?.turnId === input.payload.turnId;
  return buildLatestTurn({
    previous: input.previous,
    turnId: input.payload.turnId,
    state: input.payload.state,
    requestedAt:
      input.payload.requestedAt ?? (sameTurn ? input.previous!.requestedAt : input.occurredAt),
    startedAt: input.payload.startedAt ?? (sameTurn ? input.previous!.startedAt : input.occurredAt),
    completedAt: input.payload.completedAt ?? null,
    assistantMessageId:
      input.payload.assistantMessageId ?? (sameTurn ? input.previous!.assistantMessageId : null),
    sourceProposedPlan: input.sourceProposedPlan,
  });
}

export function withLatestTurnCheckpointState(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly turnId: TurnId;
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

export function completeLatestTurnFromCheckpoint(input: {
  readonly previous: OrchestrationLatestTurn | null;
  readonly turnId: TurnId;
  readonly status: OrchestrationCheckpointStatus;
  readonly completedAt: string;
  readonly assistantMessageId: MessageId | null;
  readonly sourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}): OrchestrationLatestTurn {
  const sameTurn = input.previous?.turnId === input.turnId;
  const resolvedState =
    sameTurn && input.previous !== null
      ? input.previous.state === "running"
        ? checkpointStatusToLatestTurnState(input.status)
        : input.previous.state
      : checkpointStatusToLatestTurnState(input.status);

  return buildLatestTurn({
    previous: input.previous,
    turnId: input.turnId,
    state: resolvedState,
    requestedAt: sameTurn ? input.previous!.requestedAt : input.completedAt,
    startedAt: sameTurn ? (input.previous!.startedAt ?? input.completedAt) : input.completedAt,
    completedAt: sameTurn ? (input.previous!.completedAt ?? input.completedAt) : input.completedAt,
    assistantMessageId: input.assistantMessageId,
    checkpointState: checkpointStatusToCaptureState(input.status),
    sourceProposedPlan: input.sourceProposedPlan,
  });
}

export function latestTurnFromCheckpoint(input: {
  readonly turnId: TurnId;
  readonly status: OrchestrationCheckpointStatus;
  readonly completedAt: string;
  readonly assistantMessageId: MessageId | null;
  readonly checkpointState?: OrchestrationTurnCheckpointState;
}): OrchestrationLatestTurn {
  return buildLatestTurn({
    previous: null,
    turnId: input.turnId,
    state: checkpointStatusToLatestTurnState(input.status),
    requestedAt: input.completedAt,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    assistantMessageId: input.assistantMessageId,
    checkpointState: input.checkpointState ?? checkpointStatusToCaptureState(input.status),
  });
}
