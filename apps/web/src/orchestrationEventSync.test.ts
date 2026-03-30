import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationCheckpointStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { applyOrchestrationEventBatch } from "./orchestrationEventSync";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import type { AppState } from "./store";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        expanded: true,
        scripts: [],
      },
    ],
    threads: [],
    threadsHydrated: true,
    ...overrides,
  };
}

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeTurnDiffEvent(input: {
  sequence: number;
  threadId?: ThreadId;
  turnId?: ReturnType<typeof TurnId.makeUnsafe>;
  status: OrchestrationCheckpointStatus;
}): OrchestrationEvent {
  const threadId = input.threadId ?? ThreadId.makeUnsafe("thread-1");
  const turnId = input.turnId ?? TurnId.makeUnsafe("turn-1");
  return makeEvent({
    sequence: input.sequence,
    type: "thread.turn-diff-completed",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: `2026-03-01T12:00:0${input.sequence}.000Z`,
    commandId: `cmd-diff-${input.sequence}`,
    payload: {
      threadId,
      turnId,
      status: input.status,
      checkpointTurnCount: 1,
      checkpointRef: "ref-1",
      files: [],
      assistantMessageId: "assistant-1",
      completedAt: `2026-03-01T12:00:0${input.sequence}.000Z`,
    },
  });
}

describe("applyOrchestrationEventBatch", () => {
  it("keeps live thread ids aligned with the final batch state", () => {
    const threadId = ThreadId.makeUnsafe("draft-backed-thread");
    const state = makeState();

    const result = applyOrchestrationEventBatch({
      state,
      latestSequence: 0,
      events: [
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:01.000Z",
          commandId: "cmd-create",
          payload: {
            threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            title: "Draft-backed thread",
            modelSelection: {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: "2026-03-01T12:00:01.000Z",
            updatedAt: "2026-03-01T12:00:01.000Z",
          },
        }),
        makeEvent({
          sequence: 2,
          type: "thread.deleted",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:02.000Z",
          commandId: "cmd-delete",
          payload: {
            threadId,
            deletedAt: "2026-03-01T12:00:02.000Z",
          },
        }),
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.state.threads).toEqual([]);
    expect(result.liveServerThreadIds.has(threadId)).toBe(false);
    expect(result.threadLifecycleChanged).toBe(true);
  });

  it("does not request invalidation for ignored placeholder diff updates", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const readySummaryState = makeState({
      threads: [
        makeThread({
          id: threadId,
          turnDiffSummaries: [
            {
              turnId,
              completedAt: "2026-03-01T12:00:01.000Z",
              status: "ready",
              checkpointTurnCount: 1,
              checkpointRef: "ref-1" as never,
              files: [],
              assistantMessageId: "assistant-1" as never,
            },
          ],
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: "2026-03-01T12:00:00.000Z",
            startedAt: "2026-03-01T12:00:00.500Z",
            completedAt: "2026-03-01T12:00:01.000Z",
            assistantMessageId: "assistant-1" as never,
          },
        }),
      ],
    });

    const result = applyOrchestrationEventBatch({
      state: readySummaryState,
      latestSequence: 1,
      events: [
        makeTurnDiffEvent({
          sequence: 2,
          threadId,
          turnId,
          status: "missing",
        }),
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.state).toBe(readySummaryState);
    expect(result.invalidateProviders).toBe(false);
    expect(result.invalidateProjects).toBe(false);
  });

  it("rejects non-contiguous replay batches", () => {
    const state = makeState();

    const result = applyOrchestrationEventBatch({
      state,
      latestSequence: 3,
      events: [
        makeEvent({
          sequence: 5,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-gap",
          occurredAt: "2026-03-01T12:00:05.000Z",
          commandId: "cmd-gap",
          payload: {
            threadId: ThreadId.makeUnsafe("thread-gap"),
            projectId: ProjectId.makeUnsafe("project-1"),
            title: "Gap thread",
            modelSelection: {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: "2026-03-01T12:00:05.000Z",
            updatedAt: "2026-03-01T12:00:05.000Z",
          },
        }),
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.state).toBe(state);
    expect(result.latestSequence).toBe(3);
  });
});
