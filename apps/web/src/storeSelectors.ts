import {
  type ApprovalRequestId,
  type MessageId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import {
  type ChatMessage,
  type Project,
  type ProposedPlan,
  type SidebarThreadSummary,
  type Thread,
  type ThreadShell,
  type ThreadSession,
  type ThreadTurnState,
  type TurnDiffSummary,
} from "./types";
import { derivePendingApprovals, derivePendingUserInputs, derivePhase } from "./session-logic";
import { getThreadFromEnvironmentState } from "./threadDerivation";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MESSAGE_IDS: readonly MessageId[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];

export interface ThreadViewShell extends ThreadShell {
  session: ThreadSession | null;
  latestTurn: ThreadTurnState["latestTurn"];
  pendingSourceProposedPlan?: ThreadTurnState["pendingSourceProposedPlan"];
}

export type ThreadStaticShellSnapshot = Pick<
  ThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "error"
  | "createdAt"
  | "branch"
  | "worktreePath"
>;

export interface ThreadRuntimeSnapshot {
  session: Pick<
    ThreadSession,
    "provider" | "status" | "activeTurnId" | "createdAt" | "updatedAt" | "orchestrationStatus"
  > | null;
  latestTurn: Pick<
    NonNullable<ThreadTurnState["latestTurn"]>,
    | "turnId"
    | "state"
    | "requestedAt"
    | "startedAt"
    | "completedAt"
    | "assistantMessageId"
    | "sourceProposedPlan"
  > | null;
  pendingSourceProposedPlan?: ThreadTurnState["pendingSourceProposedPlan"];
  phase: ReturnType<typeof derivePhase>;
}

export interface ThreadPendingSnapshot {
  pendingApprovalRequestId: ApprovalRequestId | null;
  pendingUserInputRequestId: ApprovalRequestId | null;
}

function collectByIds<TKey extends string, TValue>(
  ids: readonly TKey[] | undefined,
  byId: Record<TKey, TValue> | undefined,
): TValue[] {
  if (!ids || ids.length === 0 || !byId) {
    return [];
  }

  return ids.flatMap((id) => {
    const value = byId[id];
    return value ? [value] : [];
  });
}

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

export function createSidebarThreadSummarySelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadSummary | undefined {
  return (state) =>
    ref
      ? selectEnvironmentState(state, ref.environmentId).sidebarThreadSummaryById[ref.threadId]
      : undefined;
}

export type ThreadBranchToolbarSnapshot = Pick<
  ThreadShell,
  "environmentId" | "projectId" | "worktreePath"
>;

export function createThreadBranchToolbarSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadBranchToolbarSnapshot | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousResult: ThreadBranchToolbarSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    if (
      previousResult &&
      previousShell?.environmentId === shell.environmentId &&
      previousShell.projectId === shell.projectId &&
      previousShell.worktreePath === shell.worktreePath
    ) {
      previousShell = shell;
      return previousResult;
    }

    previousShell = shell;
    previousResult = {
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
    };
    return previousResult;
  };
}

export function createThreadStaticShellSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadStaticShellSnapshot | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousResult: ThreadStaticShellSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    if (
      previousResult &&
      previousShell?.id === shell.id &&
      previousShell.environmentId === shell.environmentId &&
      previousShell.projectId === shell.projectId &&
      previousShell.title === shell.title &&
      previousShell.modelSelection === shell.modelSelection &&
      previousShell.runtimeMode === shell.runtimeMode &&
      previousShell.interactionMode === shell.interactionMode &&
      previousShell.error === shell.error &&
      previousShell.createdAt === shell.createdAt &&
      previousShell.branch === shell.branch &&
      previousShell.worktreePath === shell.worktreePath
    ) {
      previousShell = shell;
      return previousResult;
    }

    previousShell = shell;
    previousResult = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      title: shell.title,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      error: shell.error,
      createdAt: shell.createdAt,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
    };
    return previousResult;
  };
}

export function createThreadShellSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadViewShell | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousSession: ThreadSession | null | undefined;
  let previousTurnState: ThreadTurnState | undefined;
  let previousResult: ThreadViewShell | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      return undefined;
    }

    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    const turnState = environmentState.threadTurnStateById[ref.threadId];

    if (
      previousResult &&
      previousShell === shell &&
      previousSession === session &&
      previousTurnState === turnState
    ) {
      return previousResult;
    }

    previousShell = shell;
    previousSession = session;
    previousTurnState = turnState;
    previousResult = {
      ...shell,
      session,
      latestTurn: turnState?.latestTurn ?? null,
      pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
    };
    return previousResult;
  };
}

export function createThreadRuntimeSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadRuntimeSnapshot | undefined {
  let previousSession: ThreadSession | null | undefined;
  let previousTurnState: ThreadTurnState | undefined;
  let previousResult: ThreadRuntimeSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousSession = undefined;
      previousTurnState = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousSession = undefined;
      previousTurnState = undefined;
      previousResult = undefined;
      return undefined;
    }

    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    const turnState = environmentState.threadTurnStateById[ref.threadId];
    const latestTurn = turnState?.latestTurn ?? null;
    const phase = derivePhase(session);

    if (
      previousResult &&
      previousSession?.provider === session?.provider &&
      previousSession?.status === session?.status &&
      previousSession?.activeTurnId === session?.activeTurnId &&
      previousSession?.updatedAt === session?.updatedAt &&
      previousSession?.orchestrationStatus === session?.orchestrationStatus &&
      previousTurnState?.pendingSourceProposedPlan === turnState?.pendingSourceProposedPlan &&
      previousTurnState?.latestTurn?.turnId === latestTurn?.turnId &&
      previousTurnState?.latestTurn?.requestedAt === latestTurn?.requestedAt &&
      previousTurnState?.latestTurn?.startedAt === latestTurn?.startedAt &&
      previousTurnState?.latestTurn?.completedAt === latestTurn?.completedAt &&
      previousTurnState?.latestTurn?.assistantMessageId === latestTurn?.assistantMessageId &&
      previousTurnState?.latestTurn?.sourceProposedPlan === latestTurn?.sourceProposedPlan &&
      previousResult.phase === phase
    ) {
      previousSession = session;
      previousTurnState = turnState;
      return previousResult;
    }

    previousSession = session;
    previousTurnState = turnState;
    previousResult = {
      session: session
        ? {
            provider: session.provider,
            status: session.status,
            activeTurnId: session.activeTurnId,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            orchestrationStatus: session.orchestrationStatus,
          }
        : null,
      latestTurn: latestTurn
        ? {
            turnId: latestTurn.turnId,
            state: latestTurn.state,
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt,
            completedAt: latestTurn.completedAt,
            assistantMessageId: latestTurn.assistantMessageId,
            sourceProposedPlan: latestTurn.sourceProposedPlan,
          }
        : null,
      pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
      phase,
    };
    return previousResult;
  };
}

export function createThreadMessagesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ChatMessage[] {
  let previousIds: MessageId[] | undefined;
  let previousMessagesById: EnvironmentState["messageByThreadId"][ThreadId] | undefined;
  let previousResult: ChatMessage[] = EMPTY_MESSAGES;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousMessagesById = undefined;
      previousResult = EMPTY_MESSAGES;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const messageIds = environmentState.messageIdsByThreadId[ref.threadId];
    const messagesById = environmentState.messageByThreadId[ref.threadId];

    if (previousIds === messageIds && previousMessagesById === messagesById) {
      return previousResult;
    }

    previousIds = messageIds;
    previousMessagesById = messagesById;
    const nextMessages = collectByIds(
      messageIds,
      messagesById,
    ) as Thread["messages"] extends ChatMessage[] ? ChatMessage[] : never;
    previousResult = nextMessages.length === 0 ? EMPTY_MESSAGES : nextMessages;
    return previousResult;
  };
}

export function createThreadMessageIdsSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => readonly MessageId[] {
  let previousResult: readonly MessageId[] = EMPTY_MESSAGE_IDS;

  return (state) => {
    if (!ref) {
      previousResult = EMPTY_MESSAGE_IDS;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const messageIds = environmentState.messageIdsByThreadId[ref.threadId];
    previousResult = messageIds && messageIds.length > 0 ? messageIds : EMPTY_MESSAGE_IDS;
    return previousResult;
  };
}

export function createThreadActivitiesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["activities"] {
  let previousIds: string[] | undefined;
  let previousActivitiesById: EnvironmentState["activityByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["activities"] = EMPTY_ACTIVITIES;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousActivitiesById = undefined;
      previousResult = EMPTY_ACTIVITIES;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const activityIds = environmentState.activityIdsByThreadId[ref.threadId];
    const activitiesById = environmentState.activityByThreadId[ref.threadId];

    if (previousIds === activityIds && previousActivitiesById === activitiesById) {
      return previousResult;
    }

    previousIds = activityIds;
    previousActivitiesById = activitiesById;
    const nextActivities = collectByIds(
      activityIds,
      activitiesById,
    ) as Thread["activities"] extends Array<infer _> ? Thread["activities"] : never;
    previousResult = nextActivities.length === 0 ? EMPTY_ACTIVITIES : nextActivities;
    return previousResult;
  };
}

export function createThreadPendingSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadPendingSnapshot {
  let previousIds: string[] | undefined;
  let previousActivitiesById: EnvironmentState["activityByThreadId"][ThreadId] | undefined;
  let previousResult: ThreadPendingSnapshot = {
    pendingApprovalRequestId: null,
    pendingUserInputRequestId: null,
  };

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousActivitiesById = undefined;
      previousResult = {
        pendingApprovalRequestId: null,
        pendingUserInputRequestId: null,
      };
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const activityIds = environmentState.activityIdsByThreadId[ref.threadId];
    const activitiesById = environmentState.activityByThreadId[ref.threadId];

    if (previousIds === activityIds && previousActivitiesById === activitiesById) {
      return previousResult;
    }

    previousIds = activityIds;
    previousActivitiesById = activitiesById;
    const activities = collectByIds(
      activityIds,
      activitiesById,
    ) as Thread["activities"] extends infer TActivities ? TActivities : never;
    const pendingApprovalRequestId = derivePendingApprovals(activities)[0]?.requestId ?? null;
    const pendingUserInputRequestId = derivePendingUserInputs(activities)[0]?.requestId ?? null;

    if (
      previousResult.pendingApprovalRequestId === pendingApprovalRequestId &&
      previousResult.pendingUserInputRequestId === pendingUserInputRequestId
    ) {
      return previousResult;
    }

    previousResult = {
      pendingApprovalRequestId,
      pendingUserInputRequestId,
    };
    return previousResult;
  };
}

export function createThreadProposedPlansSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["proposedPlans"] {
  let previousIds: string[] | undefined;
  let previousProposedPlansById: EnvironmentState["proposedPlanByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["proposedPlans"] = EMPTY_PROPOSED_PLANS;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousProposedPlansById = undefined;
      previousResult = EMPTY_PROPOSED_PLANS;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const proposedPlanIds = environmentState.proposedPlanIdsByThreadId[ref.threadId];
    const proposedPlansById = environmentState.proposedPlanByThreadId[ref.threadId];

    if (previousIds === proposedPlanIds && previousProposedPlansById === proposedPlansById) {
      return previousResult;
    }

    previousIds = proposedPlanIds;
    previousProposedPlansById = proposedPlansById;
    const nextProposedPlans = collectByIds(
      proposedPlanIds,
      proposedPlansById,
    ) as Thread["proposedPlans"] extends ProposedPlan[] ? ProposedPlan[] : never;
    previousResult = nextProposedPlans.length === 0 ? EMPTY_PROPOSED_PLANS : nextProposedPlans;
    return previousResult;
  };
}

export function createThreadTurnDiffSummariesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["turnDiffSummaries"] {
  let previousIds: TurnId[] | undefined;
  let previousTurnDiffsById: EnvironmentState["turnDiffSummaryByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["turnDiffSummaries"] = EMPTY_TURN_DIFF_SUMMARIES;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousTurnDiffsById = undefined;
      previousResult = EMPTY_TURN_DIFF_SUMMARIES;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const turnDiffIds = environmentState.turnDiffIdsByThreadId[ref.threadId];
    const turnDiffsById = environmentState.turnDiffSummaryByThreadId[ref.threadId];

    if (previousIds === turnDiffIds && previousTurnDiffsById === turnDiffsById) {
      return previousResult;
    }

    previousIds = turnDiffIds;
    previousTurnDiffsById = turnDiffsById;
    const nextTurnDiffSummaries = collectByIds(
      turnDiffIds,
      turnDiffsById,
    ) as Thread["turnDiffSummaries"] extends TurnDiffSummary[] ? TurnDiffSummary[] : never;
    previousResult =
      nextTurnDiffSummaries.length === 0 ? EMPTY_TURN_DIFF_SUMMARIES : nextTurnDiffSummaries;
    return previousResult;
  };
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}
