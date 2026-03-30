import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  markThreadUnread,
  reorderProjects,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
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

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          expanded: true,
          scripts: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
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
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });
});

describe("store read model sync", () => {
  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          expanded: true,
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
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
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });
});

describe("store orchestration events", () => {
  it("ignores non-material turn request events", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent({
        sequence: 1,
        type: "thread.turn-start-requested",
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: "2026-03-01T12:00:00.000Z",
        commandId: "cmd-turn-start",
        payload: {
          threadId: thread.id,
          messageId: "message-1",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-03-01T12:00:00.000Z",
        },
      }),
    );

    expect(next).toBe(state);
  });

  it("updates only the targeted thread for assistant message events", () => {
    const threadA = makeThread({ id: ThreadId.makeUnsafe("thread-a") });
    const threadB = makeThread({ id: ThreadId.makeUnsafe("thread-b") });
    const state: AppState = {
      projects: [
        {
          id: ProjectId.makeUnsafe("project-1"),
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          expanded: true,
          scripts: [],
        },
      ],
      threads: [threadA, threadB],
      threadsHydrated: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: threadB.id,
        occurredAt: "2026-03-01T12:00:01.000Z",
        commandId: "cmd-assistant-delta",
        payload: {
          threadId: threadB.id,
          messageId: "assistant-1",
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: true,
          createdAt: "2026-03-01T12:00:01.000Z",
          updatedAt: "2026-03-01T12:00:01.000Z",
        },
      }),
    );

    expect(next.threads[0]).toBe(threadA);
    expect(next.threads[1]).not.toBe(threadB);
    expect(next.threads[1]?.messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        text: "hello",
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-03-01T12:00:01.000Z",
        streaming: true,
      },
    ]);
  });

  it("keeps assistant message text when a completion event arrives after deltas", () => {
    const thread = makeThread({ id: ThreadId.makeUnsafe("thread-assistant") });
    const state = makeState(thread);

    const afterDelta = applyOrchestrationEvent(
      state,
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: "2026-03-01T12:00:01.000Z",
        commandId: "cmd-assistant-delta",
        payload: {
          threadId: thread.id,
          messageId: "assistant-1",
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: true,
          createdAt: "2026-03-01T12:00:01.000Z",
          updatedAt: "2026-03-01T12:00:01.000Z",
        },
      }),
    );

    const afterComplete = applyOrchestrationEvent(
      afterDelta,
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: "2026-03-01T12:00:02.000Z",
        commandId: "cmd-assistant-complete",
        payload: {
          threadId: thread.id,
          messageId: "assistant-1",
          role: "assistant",
          text: "",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-03-01T12:00:02.000Z",
          updatedAt: "2026-03-01T12:00:02.000Z",
        },
      }),
    );

    expect(afterComplete.threads[0]?.messages[0]).toMatchObject({
      id: "assistant-1",
      text: "hello",
      streaming: false,
      completedAt: "2026-03-01T12:00:02.000Z",
    });
  });

  it("prunes reverted turn data incrementally", () => {
    const threadId = ThreadId.makeUnsafe("thread-revert");
    const turn1 = TurnId.makeUnsafe("turn-1");
    const turn2 = TurnId.makeUnsafe("turn-2");
    const state = makeState(
      makeThread({
        id: threadId,
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: null,
            createdAt: "2026-03-01T12:00:00.000Z",
            completedAt: "2026-03-01T12:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first result",
            turnId: turn1,
            createdAt: "2026-03-01T12:00:01.000Z",
            completedAt: "2026-03-01T12:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: null,
            createdAt: "2026-03-01T12:00:02.000Z",
            completedAt: "2026-03-01T12:00:02.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-2"),
            role: "assistant",
            text: "second result",
            turnId: turn2,
            createdAt: "2026-03-01T12:00:03.000Z",
            completedAt: "2026-03-01T12:00:03.000Z",
            streaming: false,
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "tool",
            kind: "tool.started",
            summary: "first",
            payload: {},
            turnId: turn1,
            createdAt: "2026-03-01T12:00:01.500Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "tool",
            kind: "tool.started",
            summary: "second",
            payload: {},
            turnId: turn2,
            createdAt: "2026-03-01T12:00:03.500Z",
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: turn1,
            planMarkdown: "keep",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-03-01T12:00:01.200Z",
            updatedAt: "2026-03-01T12:00:01.200Z",
          },
          {
            id: "plan-2",
            turnId: turn2,
            planMarkdown: "remove",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-03-01T12:00:03.200Z",
            updatedAt: "2026-03-01T12:00:03.200Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: turn1,
            completedAt: "2026-03-01T12:00:01.100Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: "ref-1" as never,
            files: [],
            assistantMessageId: "assistant-1" as never,
          },
          {
            turnId: turn2,
            completedAt: "2026-03-01T12:00:03.100Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: "ref-2" as never,
            files: [],
            assistantMessageId: "assistant-2" as never,
          },
        ],
        latestTurn: {
          turnId: turn2,
          state: "completed",
          requestedAt: "2026-03-01T12:00:02.000Z",
          startedAt: "2026-03-01T12:00:02.100Z",
          completedAt: "2026-03-01T12:00:03.100Z",
          assistantMessageId: "assistant-2" as never,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent({
        sequence: 4,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T12:00:04.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId,
          turnCount: 1,
        },
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual(["activity-1"]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([turn1]);
    expect(next.threads[0]?.latestTurn?.turnId).toBe(turn1);
  });
});
