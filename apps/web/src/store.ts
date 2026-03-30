import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  type OrchestrationEvent,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";
import { create } from "zustand";
import { type ChatMessage, type Project, type Thread } from "./types";
import { Debouncer } from "@tanstack/react-pacer";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
};
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
        persistedProjectOrderCwds.push(cwd);
      }
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

let legacyKeysCleanedUp = false;

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: state.projects.map((project) => project.cwd),
      }),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function removeProject(projects: Project[], projectId: Project["id"]): Project[] {
  const next = projects.filter((project) => project.id !== projectId);
  return next.length === projects.length ? projects : next;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) return project;
    const updated = updater(project);
    if (updated !== project) changed = true;
    return updated;
  });
  return changed ? next : projects;
}

function upsertProject(projects: Project[], nextProject: Project): Project[] {
  const existingIndex = projects.findIndex((project) => project.id === nextProject.id);
  if (existingIndex < 0) {
    return [...projects, nextProject].toSorted(
      (left, right) =>
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  }
  if (projects[existingIndex] === nextProject) {
    return projects;
  }
  return projects.map((project, index) => (index === existingIndex ? nextProject : project));
}

function removeThread(threads: Thread[], threadId: ThreadId): Thread[] {
  const next = threads.filter((thread) => thread.id !== threadId);
  return next.length === threads.length ? threads : next;
}

function upsertThread(threads: Thread[], nextThread: Thread): Thread[] {
  const existingIndex = threads.findIndex((thread) => thread.id === nextThread.id);
  if (existingIndex < 0) {
    return [...threads, nextThread].toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }
  if (threads[existingIndex] === nextThread) {
    return threads;
  }
  return threads.map((thread, index) => (index === existingIndex ? nextThread : thread));
}

function normalizeProjectModelSelection(
  modelSelection: Project["defaultModelSelection"],
): Project["defaultModelSelection"] {
  if (modelSelection === null) {
    return null;
  }
  return {
    ...modelSelection,
    model: resolveModelSlugForProvider(modelSelection.provider, modelSelection.model),
  };
}

function normalizeThreadModelSelection(
  modelSelection: Thread["modelSelection"],
): Thread["modelSelection"] {
  return {
    ...modelSelection,
    model: resolveModelSlugForProvider(modelSelection.provider, modelSelection.model),
  };
}

function mapAttachmentsToPreviewUrls(
  attachments:
    | ReadonlyArray<{
        id: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
      }>
    | undefined,
): ChatMessage["attachments"] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));
}

function mapSession(
  session: OrchestrationReadModel["threads"][number]["session"],
): Thread["session"] {
  if (!session) {
    return null;
  }
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationReadModel["threads"][number]["checkpoints"][number],
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    const turnId = message.turnId ?? null;
    if (turnId !== null && turnId !== undefined && retainedTurnIds.has(turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter((message) => {
        const turnId = message.turnId ?? null;
        return (
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (turnId === null || turnId === undefined || retainedTurnIds.has(turnId))
        );
      })
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter((message) => {
        const turnId = message.turnId ?? null;
        return (
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (turnId === null || turnId === undefined || retainedTurnIds.has(turnId))
        );
      })
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const MAX_THREAD_ACTIVITIES = 500;

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(previous.map((project) => [project.cwd, project] as const));
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [project.cwd, index] as const),
  );
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  const mappedProjects = incoming.map((project) => {
    const existing = previousById.get(project.id) ?? previousByCwd.get(project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      defaultModelSelection:
        existing?.defaultModelSelection ??
        (project.defaultModelSelection
          ? {
              ...project.defaultModelSelection,
              model: resolveModelSlugForProvider(
                project.defaultModelSelection.provider,
                project.defaultModelSelection.model,
              ),
            }
          : null),
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      scripts: project.scripts.map((script) => ({ ...script })),
    } satisfies Project;
  });

  return mappedProjects
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(project.cwd);
      const persistedIndex = usePersistedOrder ? persistedOrderByCwd.get(project.cwd) : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? persistedProjectOrderCwds.length : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      return {
        id: thread.id,
        codexThreadId: null,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: normalizeThreadModelSelection(thread.modelSelection),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        session: mapSession(thread.session),
        messages: thread.messages.map((message) => {
          const attachments = mapAttachmentsToPreviewUrls(message.attachments);
          const normalizedMessage: ChatMessage = {
            id: message.id,
            role: message.role,
            text: message.text,
            turnId: message.turnId,
            createdAt: message.createdAt,
            streaming: message.streaming,
            ...(message.streaming ? {} : { completedAt: message.updatedAt }),
            ...(attachments !== undefined ? { attachments } : {}),
          };
          return normalizedMessage;
        }),
        proposedPlans: thread.proposedPlans.map((proposedPlan) => ({
          id: proposedPlan.id,
          turnId: proposedPlan.turnId,
          planMarkdown: proposedPlan.planMarkdown,
          implementedAt: proposedPlan.implementedAt,
          implementationThreadId: proposedPlan.implementationThreadId,
          createdAt: proposedPlan.createdAt,
          updatedAt: proposedPlan.updatedAt,
        })),
        error: thread.session?.lastError ?? null,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
        latestTurn: thread.latestTurn,
        lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
        activities: thread.activities.map((activity) => ({ ...activity })),
      };
    });
  return {
    ...state,
    projects,
    threads,
    threadsHydrated: true,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const nextProject: Project = {
        id: event.payload.projectId,
        name: event.payload.title,
        cwd: event.payload.workspaceRoot,
        defaultModelSelection: normalizeProjectModelSelection(event.payload.defaultModelSelection),
        expanded:
          persistedExpandedProjectCwds.size > 0
            ? persistedExpandedProjectCwds.has(event.payload.workspaceRoot)
            : true,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        scripts: event.payload.scripts.map((script) => ({ ...script })),
      };
      return {
        ...state,
        projects: upsertProject(state.projects, nextProject),
        threadsHydrated: true,
      };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: normalizeProjectModelSelection(
                event.payload.defaultModelSelection,
              ),
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: event.payload.scripts.map((script) => ({ ...script })) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = removeProject(state.projects, event.payload.projectId);
      return projects === state.projects ? state : { ...state, projects };
    }

    case "thread.created": {
      const nextThread: Thread = {
        id: event.payload.threadId,
        codexThreadId: null,
        projectId: event.payload.projectId,
        title: event.payload.title,
        modelSelection: normalizeThreadModelSelection(event.payload.modelSelection),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        session: null,
        messages: [],
        proposedPlans: [],
        error: null,
        createdAt: event.payload.createdAt,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
        latestTurn: null,
        lastVisitedAt: event.payload.updatedAt,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        turnDiffSummaries: [],
        activities: [],
      };
      return {
        ...state,
        threads: upsertThread(state.threads, nextThread),
        threadsHydrated: true,
      };
    }

    case "thread.deleted": {
      const threads = removeThread(state.threads, event.payload.threadId);
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.archived": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.unarchived": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.meta-updated": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeThreadModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.runtime-mode-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.interaction-mode-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.message-sent": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const existingMessage = thread.messages.find(
          (message) => message.id === event.payload.messageId,
        );
        const nextAttachments = mapAttachmentsToPreviewUrls(event.payload.attachments);
        const nextMessages = existingMessage
          ? thread.messages.map((message) =>
              message.id === event.payload.messageId
                ? {
                    ...message,
                    text: event.payload.streaming
                      ? `${message.text}${event.payload.text}`
                      : event.payload.text.length > 0
                        ? event.payload.text
                        : message.text,
                    streaming: event.payload.streaming,
                    turnId: event.payload.turnId,
                    updatedAt: event.payload.updatedAt,
                    ...(event.payload.streaming ? {} : { completedAt: event.payload.updatedAt }),
                    ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
                  }
                : message,
            )
          : [
              ...thread.messages,
              {
                id: event.payload.messageId,
                role: event.payload.role,
                text: event.payload.text,
                turnId: event.payload.turnId,
                createdAt: event.payload.createdAt,
                streaming: event.payload.streaming,
                ...(event.payload.streaming ? {} : { completedAt: event.payload.updatedAt }),
                ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
              },
            ];
        return {
          ...thread,
          messages: nextMessages.slice(-MAX_THREAD_MESSAGES),
          updatedAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.session-set": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: event.payload.session.lastError ?? null,
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? {
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
              }
            : thread.latestTurn,
        updatedAt: event.occurredAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.proposed-plan-upserted": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        proposedPlans: [
          ...thread.proposedPlans.filter((plan) => plan.id !== event.payload.proposedPlan.id),
          {
            id: event.payload.proposedPlan.id,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          },
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS),
        updatedAt: event.occurredAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.turn-diff-completed": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const existingSummary = thread.turnDiffSummaries.find(
          (summary) => summary.turnId === event.payload.turnId,
        );
        if (
          existingSummary &&
          existingSummary.status !== "missing" &&
          event.payload.status === "missing"
        ) {
          return thread;
        }
        const nextSummary: Thread["turnDiffSummaries"][number] = {
          turnId: event.payload.turnId,
          completedAt: event.payload.completedAt,
          status: event.payload.status,
          assistantMessageId: event.payload.assistantMessageId ?? undefined,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          files: event.payload.files.map((file) => ({ ...file })),
        };
        return {
          ...thread,
          turnDiffSummaries: [
            ...thread.turnDiffSummaries.filter(
              (summary) => summary.turnId !== event.payload.turnId,
            ),
            nextSummary,
          ]
            .toSorted(
              (left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0),
            )
            .slice(-MAX_THREAD_CHECKPOINTS),
          latestTurn: {
            turnId: event.payload.turnId,
            state: checkpointStatusToLatestTurnState(event.payload.status),
            requestedAt:
              thread.latestTurn?.turnId === event.payload.turnId
                ? thread.latestTurn.requestedAt
                : event.payload.completedAt,
            startedAt:
              thread.latestTurn?.turnId === event.payload.turnId
                ? (thread.latestTurn.startedAt ?? event.payload.completedAt)
                : event.payload.completedAt,
            completedAt: event.payload.completedAt,
            assistantMessageId: event.payload.assistantMessageId ?? null,
          },
          updatedAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.reverted": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter((summary) => (summary.checkpointTurnCount ?? 0) <= event.payload.turnCount)
          .toSorted(
            (left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((summary) => summary.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestSummary = turnDiffSummaries.at(-1) ?? null;
        return {
          ...thread,
          messages,
          proposedPlans,
          activities,
          turnDiffSummaries,
          latestTurn:
            latestSummary === null
              ? null
              : {
                  turnId: latestSummary.turnId,
                  state: checkpointStatusToLatestTurnState(latestSummary.status ?? "ready"),
                  requestedAt: latestSummary.completedAt,
                  startedAt: latestSummary.completedAt,
                  completedAt: latestSummary.completedAt,
                  assistantMessageId: latestSummary.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.activity-appended": {
      const threads = updateThread(state.threads, event.payload.threadId, (thread) => ({
        ...thread,
        activities: [
          ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES),
        updatedAt: event.occurredAt,
      }));
      return threads === state.threads ? state : { ...state, threads };
    }

    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.session-stop-requested":
      return state;
  }
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  return events.reduce(
    (currentState, event) => applyOrchestrationEvent(currentState, event),
    state,
  );
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
