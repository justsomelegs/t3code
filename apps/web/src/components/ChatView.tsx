import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeCodeEffort,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerProvider,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { applyClaudePromptEffortPrefix, normalizeModelSlug } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import {
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  forwardRef,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitCreateWorktreeMutationOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { isElectron } from "../env";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import { selectProjectById, selectThreadById } from "../store";
import { useProjectById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { LRUCache } from "../lib/lruCache";

import { basenameOfPath } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { cn, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { SidebarTrigger } from "./ui/sidebar";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  getProviderModelCapabilities,
  getProviderModels,
  resolveSelectableProvider,
} from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { resolveAppModelSelection } from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  deriveEffectiveComposerModelState,
  getComposerThreadDraftSnapshot,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./chat/composerProviderRegistry";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildTemporaryWorktreeBranchName,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useServerAvailableEditors,
  useServerKeybindings,
  useServerProviders,
} from "~/rpc/serverState";
import { useShallow } from "zustand/react/shallow";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_COMPOSER_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_STRING_IDS: string[] = [];

type ActiveThreadShell = Pick<
  Thread,
  | "id"
  | "projectId"
  | "title"
  | "error"
  | "createdAt"
  | "latestTurn"
  | "branch"
  | "worktreePath"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "session"
> & { hasMessages: boolean };

type ActiveThreadShellSelectorResult = Omit<ActiveThreadShell, "latestTurn"> & {
  latestTurnAssistantMessageId: MessageId | null;
  latestTurnCompletedAt: string | null;
  latestTurnRequestedAt: string | null;
  latestTurnSourcePlanId: string | null;
  latestTurnSourcePlanThreadId: ThreadId | null;
  latestTurnStartedAt: string | null;
  latestTurnState: NonNullable<Thread["latestTurn"]>["state"] | null;
  latestTurnTurnId: TurnId | null;
};

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

const MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES = 500;
const MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES = 512 * 1024;
const threadPlanCatalogCache = new LRUCache<{
  proposedPlans: Thread["proposedPlans"];
  entry: ThreadPlanCatalogEntry;
}>(MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES, MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES);

function estimateThreadPlanCatalogEntrySize(thread: Thread): number {
  return Math.max(
    64,
    thread.id.length +
      thread.proposedPlans.reduce(
        (total, plan) =>
          total +
          plan.id.length +
          plan.planMarkdown.length +
          plan.updatedAt.length +
          (plan.turnId?.length ?? 0),
        0,
      ),
  );
}

function toThreadPlanCatalogEntry(thread: Thread): ThreadPlanCatalogEntry {
  const cached = threadPlanCatalogCache.get(thread.id);
  if (cached && cached.proposedPlans === thread.proposedPlans) {
    return cached.entry;
  }

  const entry: ThreadPlanCatalogEntry = {
    id: thread.id,
    proposedPlans: thread.proposedPlans,
  };
  threadPlanCatalogCache.set(
    thread.id,
    {
      proposedPlans: thread.proposedPlans,
      entry,
    },
    estimateThreadPlanCatalogEntrySize(thread),
  );
  return entry;
}

function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  const selector = useMemo(() => {
    let previousInputs: Array<{
      id: ThreadId;
      proposedPlans: Thread["proposedPlans"];
    } | null> | null = null;
    let previousEntries: ThreadPlanCatalogEntry[] = [];

    return (state: { threads: Thread[] }): ThreadPlanCatalogEntry[] => {
      const nextThreads = threadIds.map((threadId) =>
        state.threads.find((thread) => thread.id === threadId),
      );
      const nextInputs = nextThreads.map((thread) =>
        thread ? { id: thread.id, proposedPlans: thread.proposedPlans } : null,
      );
      const cachedInputs = previousInputs;
      if (
        cachedInputs &&
        nextInputs.length === cachedInputs.length &&
        nextInputs.every(
          (thread, index) =>
            thread?.id === cachedInputs[index]?.id &&
            thread?.proposedPlans === cachedInputs[index]?.proposedPlans,
        )
      ) {
        return previousEntries;
      }

      previousInputs = nextInputs;
      previousEntries = nextThreads.flatMap((thread) =>
        thread ? [toThreadPlanCatalogEntry(thread)] : [],
      );
      return previousEntries;
    };
  }, [threadIds]);

  return useStore(selector);
}

function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

interface ChatViewProps {
  threadId: ThreadId;
}

interface PendingPullRequestSetupRequest {
  threadId: ThreadId;
  worktreePath: string;
  scriptId: string;
}

function useLocalDispatchState(input: {
  activeThread: (Pick<Thread, "latestTurn" | "session"> & Partial<Thread>) | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}

function useStableCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}

interface TimelinePaneProps {
  threadId: ThreadId;
  optimisticUserMessages: ChatMessage[];
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  isWorking: boolean;
  localDispatchStartedAt: string | null;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevertToTurnCount: (turnCount: number) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
}

interface TimelinePaneHandle {
  forceStickToBottom: () => void;
}

const ChatHeaderPane = memo(function ChatHeaderPane(props: {
  threadId: ThreadId;
  preferredScriptIdByProjectId: Readonly<Record<string, string>>;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}) {
  const threadSelection = useStore(
    useShallow((state): Pick<Thread, "id" | "projectId" | "title" | "worktreePath"> | undefined => {
      const thread = selectThreadById(props.threadId)(state);
      if (!thread) {
        return undefined;
      }
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        worktreePath: thread.worktreePath,
      };
    }),
  );
  const activeProject = useProjectById(threadSelection?.projectId);
  const terminalOpen = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).terminalOpen,
  );
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const diffToggleShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "diff.toggle", {
        context: {
          terminalFocus: false,
          terminalOpen: Boolean(terminalOpen),
        },
      }),
    [keybindings, terminalOpen],
  );
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: threadSelection?.worktreePath ?? null,
      })
    : null;
  const branchesQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const isGitRepo = branchesQuery.data?.isRepo ?? true;

  if (!threadSelection) {
    return null;
  }

  return (
    <ChatHeader
      activeThreadId={threadSelection.id}
      activeThreadTitle={threadSelection.title}
      activeProjectName={activeProject?.name}
      isGitRepo={isGitRepo}
      openInCwd={gitCwd}
      activeProjectScripts={activeProject?.scripts}
      preferredScriptId={
        activeProject ? (props.preferredScriptIdByProjectId[activeProject.id] ?? null) : null
      }
      keybindings={keybindings}
      availableEditors={availableEditors}
      terminalAvailable={activeProject !== undefined}
      terminalOpen={terminalOpen}
      terminalToggleShortcutLabel={terminalToggleShortcutLabel}
      diffToggleShortcutLabel={diffToggleShortcutLabel}
      gitCwd={gitCwd}
      diffOpen={props.diffOpen}
      onRunProjectScript={props.onRunProjectScript}
      onAddProjectScript={props.onAddProjectScript}
      onUpdateProjectScript={props.onUpdateProjectScript}
      onDeleteProjectScript={props.onDeleteProjectScript}
      onToggleTerminal={props.onToggleTerminal}
      onToggleDiff={props.onToggleDiff}
    />
  );
});

const TimelinePane = memo(
  forwardRef<TimelinePaneHandle, TimelinePaneProps>(function TimelinePane(
    {
      threadId,
      optimisticUserMessages,
      attachmentPreviewHandoffByMessageId,
      isWorking,
      localDispatchStartedAt,
      onOpenTurnDiff,
      onRevertToTurnCount,
      isRevertingCheckpoint,
      onImageExpand,
      resolvedTheme,
      timestampFormat,
    }: TimelinePaneProps,
    ref,
  ) {
    const timelineThread = useStore(
      useShallow(
        (
          state,
        ):
          | Pick<
              Thread,
              | "activities"
              | "id"
              | "latestTurn"
              | "messages"
              | "projectId"
              | "proposedPlans"
              | "session"
              | "turnDiffSummaries"
              | "worktreePath"
            >
          | undefined => {
          const thread = selectThreadById(threadId)(state);
          if (!thread) {
            return undefined;
          }
          return {
            id: thread.id,
            latestTurn: thread.latestTurn,
            session: thread.session,
            projectId: thread.projectId,
            worktreePath: thread.worktreePath,
            messages: thread.messages,
            proposedPlans: thread.proposedPlans,
            turnDiffSummaries: thread.turnDiffSummaries,
            activities: thread.activities,
          };
        },
      ),
    );
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
    const messagesScrollRef = useRef<HTMLDivElement>(null);
    const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
    const shouldAutoScrollRef = useRef(true);
    const lastKnownScrollTopRef = useRef(0);
    const isPointerScrollActiveRef = useRef(false);
    const lastTouchClientYRef = useRef<number | null>(null);
    const pendingUserScrollUpIntentRef = useRef(false);
    const pendingAutoScrollFrameRef = useRef<number | null>(null);
    const pendingInteractionAnchorRef = useRef<{
      element: HTMLElement;
      top: number;
    } | null>(null);
    const pendingInteractionAnchorFrameRef = useRef<number | null>(null);

    const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
      messagesScrollRef.current = element;
      setMessagesScrollElement(element);
    }, []);
    const activeLatestTurn = timelineThread?.latestTurn ?? null;
    const latestTurnSettled = isLatestTurnSettled(
      activeLatestTurn,
      timelineThread?.session ?? null,
    );
    const threadActivities = timelineThread?.activities ?? EMPTY_ACTIVITIES;
    const workLogEntries = useMemo(
      () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
      [activeLatestTurn?.turnId, threadActivities],
    );
    const latestTurnHasToolActivity = useMemo(
      () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
      [activeLatestTurn?.turnId, threadActivities],
    );
    const activeProject = useProjectById(timelineThread?.projectId);
    const gitCwd = activeProject
      ? projectScriptCwd({
          project: { cwd: activeProject.cwd },
          worktreePath: timelineThread?.worktreePath ?? null,
        })
      : null;
    const serverMessages = timelineThread?.messages ?? EMPTY_CHAT_MESSAGES;
    const timelineMessages = useMemo(() => {
      const serverMessagesWithPreviewHandoff =
        Object.keys(attachmentPreviewHandoffByMessageId).length === 0
          ? serverMessages
          : serverMessages.map((message) => {
              if (
                message.role !== "user" ||
                !message.attachments ||
                message.attachments.length === 0
              ) {
                return message;
              }
              const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
              if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
                return message;
              }

              let changed = false;
              let imageIndex = 0;
              const attachments = message.attachments.map((attachment) => {
                if (attachment.type !== "image") {
                  return attachment;
                }
                const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
                imageIndex += 1;
                if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                  return attachment;
                }
                changed = true;
                return {
                  ...attachment,
                  previewUrl: handoffPreviewUrl,
                };
              });

              return changed ? { ...message, attachments } : message;
            });

      if (optimisticUserMessages.length === 0) {
        return serverMessagesWithPreviewHandoff;
      }
      const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
      const pendingMessages = optimisticUserMessages.filter(
        (message) => !serverIds.has(message.id),
      );
      if (pendingMessages.length === 0) {
        return serverMessagesWithPreviewHandoff;
      }
      return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
    }, [attachmentPreviewHandoffByMessageId, optimisticUserMessages, serverMessages]);
    const timelineEntries = useMemo(
      () =>
        deriveTimelineEntries(
          timelineMessages,
          timelineThread?.proposedPlans ?? [],
          workLogEntries,
        ),
      [timelineThread?.proposedPlans, timelineMessages, workLogEntries],
    );
    const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(
      timelineThread?.turnDiffSummaries,
    );
    const turnDiffSummaryByAssistantMessageId = useMemo(() => {
      const byMessageId = new Map<MessageId, TurnDiffSummary>();
      for (const summary of turnDiffSummaries) {
        if (!summary.assistantMessageId) continue;
        byMessageId.set(summary.assistantMessageId, summary);
      }
      return byMessageId;
    }, [turnDiffSummaries]);
    const revertTurnCountByUserMessageId = useMemo(() => {
      const byUserMessageId = new Map<MessageId, number>();
      for (let index = 0; index < timelineEntries.length; index += 1) {
        const entry = timelineEntries[index];
        if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
          continue;
        }

        for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
          const nextEntry = timelineEntries[nextIndex];
          if (!nextEntry || nextEntry.kind !== "message") {
            continue;
          }
          if (nextEntry.message.role === "user") {
            break;
          }
          const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
          if (!summary) {
            continue;
          }
          const turnCount =
            summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
          if (typeof turnCount !== "number") {
            break;
          }
          byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
          break;
        }
      }

      return byUserMessageId;
    }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);
    const completionSummary = useMemo(() => {
      if (!latestTurnSettled) return null;
      if (!activeLatestTurn?.startedAt) return null;
      if (!activeLatestTurn.completedAt) return null;
      if (!latestTurnHasToolActivity) return null;

      const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
      return elapsed ? `Worked for ${elapsed}` : null;
    }, [
      activeLatestTurn?.completedAt,
      activeLatestTurn?.startedAt,
      latestTurnHasToolActivity,
      latestTurnSettled,
    ]);
    const completionDividerBeforeEntryId = useMemo(() => {
      if (!latestTurnSettled) return null;
      if (!completionSummary) return null;
      return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
    }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
    const activeWorkStartedAt = deriveActiveWorkStartedAt(
      activeLatestTurn,
      timelineThread?.session ?? null,
      localDispatchStartedAt,
    );
    const messageCount = serverMessages.length + optimisticUserMessages.length;
    const timelineChangeKey = `${messageCount}:${threadActivities.length}:${timelineThread?.proposedPlans.length ?? 0}`;
    const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      shouldAutoScrollRef.current = true;
    }, []);
    const cancelPendingStickToBottom = useCallback(() => {
      const pendingFrame = pendingAutoScrollFrameRef.current;
      if (pendingFrame === null) return;
      pendingAutoScrollFrameRef.current = null;
      window.cancelAnimationFrame(pendingFrame);
    }, []);
    const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame === null) return;
      pendingInteractionAnchorFrameRef.current = null;
      window.cancelAnimationFrame(pendingFrame);
    }, []);
    const scheduleStickToBottom = useCallback(() => {
      if (pendingAutoScrollFrameRef.current !== null) return;
      pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
        pendingAutoScrollFrameRef.current = null;
        scrollMessagesToBottom();
      });
    }, [scrollMessagesToBottom]);
    const forceStickToBottom = useCallback(() => {
      cancelPendingStickToBottom();
      scrollMessagesToBottom();
      scheduleStickToBottom();
    }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
    const onMessagesClickCapture = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const scrollContainer = messagesScrollRef.current;
        if (!scrollContainer || !(event.target instanceof Element)) return;

        const trigger = event.target.closest<HTMLElement>(
          "button, summary, [role='button'], [data-scroll-anchor-target]",
        );
        if (!trigger || !scrollContainer.contains(trigger)) return;
        if (trigger.closest("[data-scroll-anchor-ignore]")) return;

        pendingInteractionAnchorRef.current = {
          element: trigger,
          top: trigger.getBoundingClientRect().top,
        };

        cancelPendingInteractionAnchorAdjustment();
        pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
          pendingInteractionAnchorFrameRef.current = null;
          const anchor = pendingInteractionAnchorRef.current;
          pendingInteractionAnchorRef.current = null;
          const activeScrollContainer = messagesScrollRef.current;
          if (!anchor || !activeScrollContainer) return;
          if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element))
            return;

          const nextTop = anchor.element.getBoundingClientRect().top;
          const delta = nextTop - anchor.top;
          if (Math.abs(delta) < 0.5) return;

          activeScrollContainer.scrollTop += delta;
          lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
        });
      },
      [cancelPendingInteractionAnchorAdjustment],
    );
    const onMessagesScroll = useCallback(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      const currentScrollTop = scrollContainer.scrollTop;
      const isNearBottom = isScrollContainerNearBottom(scrollContainer);

      if (!shouldAutoScrollRef.current && isNearBottom) {
        shouldAutoScrollRef.current = true;
        pendingUserScrollUpIntentRef.current = false;
      } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
        const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
        if (scrolledUp) {
          shouldAutoScrollRef.current = false;
        }
        pendingUserScrollUpIntentRef.current = false;
      } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
        const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
        if (scrolledUp) {
          shouldAutoScrollRef.current = false;
        }
      } else if (shouldAutoScrollRef.current && !isNearBottom) {
        const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
        if (scrolledUp) {
          shouldAutoScrollRef.current = false;
        }
      }

      setShowScrollToBottom(!shouldAutoScrollRef.current);
      lastKnownScrollTopRef.current = currentScrollTop;
    }, []);
    const onMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        pendingUserScrollUpIntentRef.current = true;
      }
    }, []);
    const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
      isPointerScrollActiveRef.current = true;
    }, []);
    const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
      isPointerScrollActiveRef.current = false;
    }, []);
    const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
      isPointerScrollActiveRef.current = false;
    }, []);
    const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      lastTouchClientYRef.current = touch.clientY;
    }, []);
    const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      const previousTouchY = lastTouchClientYRef.current;
      if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
        pendingUserScrollUpIntentRef.current = true;
      }
      lastTouchClientYRef.current = touch.clientY;
    }, []);
    const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
      lastTouchClientYRef.current = null;
    }, []);
    const onToggleWorkGroup = useCallback((groupId: string) => {
      setExpandedWorkGroups((existing) => ({
        ...existing,
        [groupId]: !existing[groupId],
      }));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        forceStickToBottom,
      }),
      [forceStickToBottom],
    );

    useEffect(() => {
      return () => {
        cancelPendingStickToBottom();
        cancelPendingInteractionAnchorAdjustment();
      };
    }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
    useLayoutEffect(() => {
      if (!timelineThread?.id) return;
      shouldAutoScrollRef.current = true;
      scheduleStickToBottom();
      const timeout = window.setTimeout(() => {
        const scrollContainer = messagesScrollRef.current;
        if (!scrollContainer) return;
        if (isScrollContainerNearBottom(scrollContainer)) return;
        scheduleStickToBottom();
      }, 96);
      return () => {
        window.clearTimeout(timeout);
      };
    }, [timelineThread?.id, scheduleStickToBottom]);
    useEffect(() => {
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    }, [messageCount, scheduleStickToBottom]);
    useEffect(() => {
      if (!isWorking) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    }, [isWorking, scheduleStickToBottom, timelineChangeKey]);
    useEffect(() => {
      setExpandedWorkGroups({});
    }, [timelineThread?.id]);
    const handleRevertUserMessage = useCallback(
      (messageId: MessageId) => {
        const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
        if (typeof targetTurnCount !== "number") {
          return;
        }
        void onRevertToTurnCount(targetTurnCount);
      },
      [onRevertToTurnCount, revertTurnCountByUserMessageId],
    );

    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={setMessagesScrollContainerRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
          onScroll={onMessagesScroll}
          onClickCapture={onMessagesClickCapture}
          onWheel={onMessagesWheel}
          onPointerDown={onMessagesPointerDown}
          onPointerUp={onMessagesPointerUp}
          onPointerCancel={onMessagesPointerCancel}
          onTouchStart={onMessagesTouchStart}
          onTouchMove={onMessagesTouchMove}
          onTouchEnd={onMessagesTouchEnd}
          onTouchCancel={onMessagesTouchEnd}
        >
          <MessagesTimeline
            key={threadId}
            threadId={threadId}
            hasMessages={timelineEntries.length > 0}
            isWorking={isWorking}
            activeTurnInProgress={isWorking || !latestTurnSettled}
            activeTurnStartedAt={activeWorkStartedAt}
            scrollContainer={messagesScrollElement}
            timelineEntries={timelineEntries}
            completionDividerBeforeEntryId={completionDividerBeforeEntryId}
            completionSummary={completionSummary}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
            onOpenTurnDiff={onOpenTurnDiff}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={handleRevertUserMessage}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onImageExpand}
            markdownCwd={gitCwd ?? undefined}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
            workspaceRoot={activeProject?.cwd ?? undefined}
          />
        </div>
        {showScrollToBottom && (
          <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
            <button
              type="button"
              onClick={() => scrollMessagesToBottom("smooth")}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
            >
              <ChevronDownIcon className="size-3.5" />
              Scroll to bottom
            </button>
          </div>
        )}
      </div>
    );
  }),
);

interface ComposerPaneProps {
  threadId: ThreadId;
  phase: SessionPhase;
  gitCwd: string | null;
  isGitRepo: boolean;
  isDragOverComposer: boolean;
  resolvedTheme: "light" | "dark";
  composerFormRef: RefObject<HTMLFormElement | null>;
  composerFooterRef: RefObject<HTMLDivElement | null>;
  composerFooterLeadingRef: RefObject<HTMLDivElement | null>;
  composerFooterActionsRef: RefObject<HTMLDivElement | null>;
  promptRef: MutableRefObject<string>;
  composerImagesRef: MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: MutableRefObject<TerminalContextDraft[]>;
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  providerStatuses: ReadonlyArray<ServerProvider>;
  composerModelOptions: ReturnType<typeof deriveEffectiveComposerModelState>["modelOptions"];
  lockedProvider: ProviderKind | null;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  activePlan: ReturnType<typeof deriveActivePlanState>;
  sidebarProposedPlan: ReturnType<typeof findSidebarProposedPlan>;
  planSidebarOpen: boolean;
  activeProposedPlan: ReturnType<typeof findLatestProposedPlan>;
  activePendingApproval: ReturnType<typeof derivePendingApprovals>[number] | null;
  pendingApprovalsCount: number;
  pendingUserInputs: ReturnType<typeof derivePendingUserInputs>;
  respondingRequestIds: ApprovalRequestId[];
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  activePendingProgress: ReturnType<typeof derivePendingUserInputProgress> | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  isComposerApprovalState: boolean;
  isPreparingWorktree: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isComposerFooterCompact: boolean;
  isComposerPrimaryActionsCompact: boolean;
  onSend: (e?: { preventDefault: () => void }) => Promise<void> | void;
  onPendingUserInputCustomAnswerChange: (questionId: string, value: string) => void;
  onComposerPaste: (event: ClipboardEvent<HTMLElement>) => boolean | void;
  onComposerDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onComposerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onComposerDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onImplementPlanInNewThread: () => Promise<void>;
  onRemoveComposerImage: (imageId: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onProviderModelSelect: (provider: ProviderKind, model: string) => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  toggleInteractionMode: () => void;
  togglePlanSidebar: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void | Promise<void>;
}

interface ComposerPaneHandle {
  focusAtEnd: () => void;
  insertTerminalContext: (selection: TerminalContextSelection) => void;
}

const ComposerPane = memo(
  forwardRef<ComposerPaneHandle, ComposerPaneProps>(function ComposerPane(
    {
      threadId,
      phase,
      gitCwd,
      isGitRepo,
      isDragOverComposer,
      resolvedTheme,
      composerFormRef,
      composerFooterRef,
      composerFooterLeadingRef,
      composerFooterActionsRef,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      selectedProvider,
      selectedModel,
      selectedProviderModels,
      providerStatuses,
      composerModelOptions,
      lockedProvider,
      interactionMode,
      runtimeMode,
      activePlan,
      sidebarProposedPlan,
      planSidebarOpen,
      activeProposedPlan,
      activePendingApproval,
      pendingApprovalsCount,
      pendingUserInputs,
      respondingRequestIds,
      activePendingDraftAnswers,
      activePendingQuestionIndex,
      activePendingProgress,
      activePendingResolvedAnswers,
      activePendingIsResponding,
      activeContextWindow,
      isComposerApprovalState,
      isPreparingWorktree,
      isSendBusy,
      isConnecting,
      isComposerFooterCompact,
      isComposerPrimaryActionsCompact,
      onSend,
      onPendingUserInputCustomAnswerChange,
      onComposerPaste,
      onComposerDragEnter,
      onComposerDragOver,
      onComposerDragLeave,
      onComposerDrop,
      onSelectActivePendingUserInputOption,
      onAdvanceActivePendingUserInput,
      onPreviousActivePendingUserInputQuestion,
      onRespondToApproval,
      onInterrupt,
      onImplementPlanInNewThread,
      onRemoveComposerImage,
      onImageExpand,
      onProviderModelSelect,
      onInteractionModeChange,
      toggleInteractionMode,
      togglePlanSidebar,
      handleRuntimeModeChange,
    }: ComposerPaneProps,
    ref,
  ) {
    const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
    const composerImages = useComposerDraftStore(
      (state) => state.draftsByThreadId[threadId]?.images ?? EMPTY_COMPOSER_IMAGES,
    );
    const composerTerminalContexts = useComposerDraftStore(
      (state) => state.draftsByThreadId[threadId]?.terminalContexts ?? EMPTY_TERMINAL_CONTEXTS,
    );
    const nonPersistedComposerImageIds = useComposerDraftStore(
      (state) => state.draftsByThreadId[threadId]?.nonPersistedImageIds ?? EMPTY_STRING_IDS,
    );
    const clearComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.clearPersistedAttachments,
    );
    const syncComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.syncPersistedAttachments,
    );
    const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
    const setComposerDraftTerminalContexts = useComposerDraftStore(
      (store) => store.setTerminalContexts,
    );
    const insertComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.insertTerminalContext,
    );
    const removeComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.removeTerminalContext,
    );
    const displayedPrompt = isComposerApprovalState
      ? ""
      : activePendingProgress
        ? activePendingProgress.customAnswer
        : prompt;
    const [composerCursor, setComposerCursor] = useState(() =>
      collapseExpandedComposerCursor(displayedPrompt, displayedPrompt.length),
    );
    const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
      detectComposerTrigger(displayedPrompt, displayedPrompt.length),
    );
    const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
    const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
    const latestLocalPromptRef = useRef(displayedPrompt);
    const composerMenuOpenRef = useRef(false);
    const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
    const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);

    useEffect(() => {
      promptRef.current = displayedPrompt;
    }, [displayedPrompt, promptRef]);

    useEffect(() => {
      composerImagesRef.current = composerImages;
    }, [composerImages, composerImagesRef]);

    useEffect(() => {
      composerTerminalContextsRef.current = composerTerminalContexts;
    }, [composerTerminalContexts, composerTerminalContextsRef]);

    useEffect(() => {
      let cancelled = false;
      void (async () => {
        if (composerImages.length === 0) {
          clearComposerDraftPersistedAttachments(threadId);
          return;
        }
        const getPersistedAttachmentsForThread = () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
        try {
          const currentPersistedAttachments = getPersistedAttachmentsForThread();
          const existingPersistedById = new Map(
            currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
          );
          const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
          await Promise.all(
            composerImages.map(async (image) => {
              try {
                const dataUrl = await readFileAsDataUrl(image.file);
                stagedAttachmentById.set(image.id, {
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  sizeBytes: image.sizeBytes,
                  dataUrl,
                });
              } catch {
                const existingPersisted = existingPersistedById.get(image.id);
                if (existingPersisted) {
                  stagedAttachmentById.set(image.id, existingPersisted);
                }
              }
            }),
          );
          if (!cancelled) {
            syncComposerDraftPersistedAttachments(
              threadId,
              Array.from(stagedAttachmentById.values()),
            );
          }
        } catch {
          const currentImageIds = new Set(composerImages.map((image) => image.id));
          const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
          const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
            currentImageIds.has(attachment.id),
          );
          if (!cancelled) {
            syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [
      clearComposerDraftPersistedAttachments,
      composerImages,
      syncComposerDraftPersistedAttachments,
      threadId,
    ]);

    const persistDraftPrompt = useCallback(
      (nextPrompt: string, terminalContextIds: readonly string[]) => {
        setComposerDraftPrompt(threadId, nextPrompt);
        if (!terminalContextIdListsEqual(composerTerminalContextsRef.current, terminalContextIds)) {
          const nextTerminalContexts = syncTerminalContextsByIds(
            composerTerminalContextsRef.current,
            terminalContextIds,
          );
          setComposerDraftTerminalContexts(threadId, nextTerminalContexts);
          composerTerminalContextsRef.current = nextTerminalContexts;
        }
      },
      [
        composerTerminalContextsRef,
        setComposerDraftPrompt,
        setComposerDraftTerminalContexts,
        threadId,
      ],
    );
    const syncComposerEditorState = useCallback(
      (
        nextPrompt: string,
        nextCursor: number,
        expandedCursor: number,
        cursorAdjacentToMention: boolean,
      ) => {
        latestLocalPromptRef.current = nextPrompt;
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
      },
      [],
    );
    const handleComposerPromptChange = useCallback(
      (
        nextPrompt: string,
        nextCursor: number,
        expandedCursor: number,
        cursorAdjacentToMention: boolean,
        terminalContextIds: string[],
      ) => {
        promptRef.current = nextPrompt;
        const activePendingQuestionId = activePendingProgress?.activeQuestion?.id;
        if (activePendingQuestionId) {
          onPendingUserInputCustomAnswerChange(activePendingQuestionId, nextPrompt);
        } else {
          persistDraftPrompt(nextPrompt, terminalContextIds);
        }
        syncComposerEditorState(nextPrompt, nextCursor, expandedCursor, cursorAdjacentToMention);
      },
      [
        activePendingProgress?.activeQuestion?.id,
        onPendingUserInputCustomAnswerChange,
        persistDraftPrompt,
        promptRef,
        syncComposerEditorState,
      ],
    );
    const handlePromptChangeFromTraits = useCallback(
      (nextPrompt: string) => {
        if (nextPrompt === promptRef.current) {
          return;
        }
        handleComposerPromptChange(
          nextPrompt,
          collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
          nextPrompt.length,
          false,
          composerTerminalContexts.map((context) => context.id),
        );
      },
      [composerTerminalContexts, handleComposerPromptChange, promptRef],
    );
    const modelOptionsByProvider = useMemo(
      () => ({
        codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
        claudeAgent:
          providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
      }),
      [providerStatuses],
    );
    const searchableModelOptions = useMemo(
      () =>
        AVAILABLE_PROVIDER_OPTIONS.filter(
          (option) => lockedProvider === null || option.value === lockedProvider,
        ).flatMap((option) =>
          modelOptionsByProvider[option.value].map(({ slug, name }) => ({
            provider: option.value,
            providerLabel: option.label,
            slug,
            name,
            searchSlug: slug.toLowerCase(),
            searchName: name.toLowerCase(),
            searchProvider: option.label.toLowerCase(),
          })),
        ),
      [lockedProvider, modelOptionsByProvider],
    );
    const composerTriggerKind = composerTrigger?.kind ?? null;
    const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
    const isPathTrigger = composerTriggerKind === "path";
    const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(pathTriggerQuery, {
      wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS,
    });
    const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
    const workspaceEntriesQuery = useQuery(
      projectSearchEntriesQueryOptions({
        cwd: gitCwd,
        query: effectivePathQuery,
        enabled: isPathTrigger,
        limit: 80,
      }),
    );
    const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
    const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
      if (!composerTrigger) return [];
      if (composerTrigger.kind === "path") {
        return workspaceEntries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path",
          path: entry.path,
          pathKind: entry.kind,
          label: basenameOfPath(entry.path),
          description: entry.parentPath ?? "",
        }));
      }

      if (composerTrigger.kind === "slash-command") {
        const slashCommandItems = [
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
          {
            id: "slash:plan",
            type: "slash-command",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            id: "slash:default",
            type: "slash-command",
            command: "default",
            label: "/default",
            description: "Switch this thread back to normal chat mode",
          },
        ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) {
          return [...slashCommandItems];
        }
        return slashCommandItems.filter(
          (item) => item.command.includes(query) || item.label.slice(1).includes(query),
        );
      }

      return searchableModelOptions
        .filter(({ searchSlug, searchName, searchProvider }) => {
          const query = composerTrigger.query.trim().toLowerCase();
          if (!query) return true;
          return (
            searchSlug.includes(query) ||
            searchName.includes(query) ||
            searchProvider.includes(query)
          );
        })
        .map(({ provider, providerLabel, slug, name }) => ({
          id: `model:${provider}:${slug}`,
          type: "model",
          provider,
          model: slug,
          label: name,
          description: `${providerLabel} · ${slug}`,
        }));
    }, [composerTrigger, searchableModelOptions, workspaceEntries]);
    const composerMenuOpen = Boolean(composerTrigger);
    const activeComposerMenuItem = useMemo(
      () =>
        composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
        composerMenuItems[0] ??
        null,
      [composerHighlightedItemId, composerMenuItems],
    );
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
    const isComposerMenuLoading =
      composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching);
    const readComposerSnapshot = useCallback(() => {
      const editorSnapshot = composerEditorRef.current?.readSnapshot();
      if (editorSnapshot) {
        return editorSnapshot;
      }
      return {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContextsRef.current.map((context) => context.id),
      };
    }, [composerCursor, composerTerminalContextsRef, promptRef]);
    const applyPromptReplacement = useCallback(
      (
        rangeStart: number,
        rangeEnd: number,
        replacement: string,
        options?: { expectedText?: string },
      ): boolean => {
        const currentText = promptRef.current;
        const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
        const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
        if (
          options?.expectedText !== undefined &&
          currentText.slice(safeStart, safeEnd) !== options.expectedText
        ) {
          return false;
        }
        const next = replaceTextRange(currentText, rangeStart, rangeEnd, replacement);
        const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
        promptRef.current = next.text;
        const activePendingQuestionId = activePendingProgress?.activeQuestion?.id;
        if (activePendingQuestionId) {
          onPendingUserInputCustomAnswerChange(activePendingQuestionId, next.text);
        } else {
          persistDraftPrompt(
            next.text,
            composerTerminalContextsRef.current.map((context) => context.id),
          );
        }
        syncComposerEditorState(
          next.text,
          nextCursor,
          expandCollapsedComposerCursor(next.text, nextCursor),
          false,
        );
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
        return true;
      },
      [
        activePendingProgress?.activeQuestion?.id,
        composerTerminalContextsRef,
        onPendingUserInputCustomAnswerChange,
        persistDraftPrompt,
        promptRef,
        syncComposerEditorState,
      ],
    );
    const resolveActiveComposerTrigger = useCallback(() => {
      const snapshot = readComposerSnapshot();
      return {
        snapshot,
        trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      };
    }, [readComposerSnapshot]);
    const handleSelectComposerItem = useCallback(
      (item: ComposerCommandItem) => {
        const { snapshot, trigger } = resolveActiveComposerTrigger();
        if (!trigger) return;
        if (item.type === "path") {
          const replacement = `@${item.path} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "slash-command") {
          if (item.command === "model") {
            const replacement = "/model ";
            const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
              snapshot.value,
              trigger.rangeEnd,
              replacement,
            );
            const applied = applyPromptReplacement(
              trigger.rangeStart,
              replacementRangeEnd,
              replacement,
              { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
            );
            if (applied) {
              setComposerHighlightedItemId(null);
            }
            return;
          }
          onInteractionModeChange(item.command === "plan" ? "plan" : "default");
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        onProviderModelSelect(item.provider, item.model);
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
      },
      [
        applyPromptReplacement,
        onInteractionModeChange,
        onProviderModelSelect,
        resolveActiveComposerTrigger,
      ],
    );
    const nudgeComposerMenuHighlight = useCallback(
      (key: "ArrowDown" | "ArrowUp") => {
        if (composerMenuItems.length === 0) {
          return;
        }
        const highlightedIndex = composerMenuItems.findIndex(
          (item) => item.id === composerHighlightedItemId,
        );
        const normalizedIndex =
          highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
        const offset = key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
        const nextItem = composerMenuItems[nextIndex];
        setComposerHighlightedItemId(nextItem?.id ?? null);
      },
      [composerHighlightedItemId, composerMenuItems],
    );
    const handleComposerCommandKey = useCallback(
      (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: globalThis.KeyboardEvent) => {
        if (key === "Tab" && event.shiftKey) {
          event.preventDefault();
          toggleInteractionMode();
          return true;
        }

        const { trigger } = resolveActiveComposerTrigger();
        const menuIsActive = composerMenuOpenRef.current || trigger !== null;
        if (!menuIsActive) return false;
        const currentItems = composerMenuItemsRef.current;
        if (key === "ArrowDown") {
          event.preventDefault();
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp") {
          event.preventDefault();
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if (key === "Enter" || key === "Tab") {
          if (currentItems.length === 0) return false;
          event.preventDefault();
          const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
          if (selectedItem) {
            handleSelectComposerItem(selectedItem);
          }
          return true;
        }
        return false;
      },
      [
        handleSelectComposerItem,
        nudgeComposerMenuHighlight,
        resolveActiveComposerTrigger,
        toggleInteractionMode,
      ],
    );
    const handleRemoveTerminalContext = useCallback(
      (contextId: string) => {
        const contextIndex = composerTerminalContextsRef.current.findIndex(
          (context) => context.id === contextId,
        );
        if (contextIndex < 0) {
          return;
        }
        const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
        promptRef.current = nextPrompt.prompt;
        latestLocalPromptRef.current = nextPrompt.prompt;
        setComposerDraftPrompt(threadId, nextPrompt.prompt);
        removeComposerDraftTerminalContext(threadId, contextId);
        composerTerminalContextsRef.current = composerTerminalContextsRef.current.filter(
          (context) => context.id !== contextId,
        );
        setComposerCursor(nextPrompt.cursor);
        setComposerTrigger(
          detectComposerTrigger(
            nextPrompt.prompt,
            expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
          ),
        );
      },
      [
        composerTerminalContextsRef,
        promptRef,
        removeComposerDraftTerminalContext,
        setComposerDraftPrompt,
        threadId,
      ],
    );
    useImperativeHandle(
      ref,
      () => ({
        focusAtEnd: () => {
          composerEditorRef.current?.focusAtEnd();
        },
        insertTerminalContext: (selection) => {
          if (isComposerApprovalState || activePendingProgress) {
            return;
          }
          const snapshot = readComposerSnapshot();
          const insertion = insertInlineTerminalContextPlaceholder(
            snapshot.value,
            snapshot.expandedCursor,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            insertion.prompt,
            insertion.cursor,
          );
          const inserted = insertComposerDraftTerminalContext(
            threadId,
            insertion.prompt,
            {
              id: randomUUID(),
              threadId,
              createdAt: new Date().toISOString(),
              ...selection,
            },
            insertion.contextIndex,
          );
          if (!inserted) {
            return;
          }
          promptRef.current = insertion.prompt;
          latestLocalPromptRef.current = insertion.prompt;
          composerTerminalContextsRef.current =
            getComposerThreadDraftSnapshot(threadId).terminalContexts;
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
      }),
      [
        activePendingProgress,
        composerTerminalContextsRef,
        insertComposerDraftTerminalContext,
        isComposerApprovalState,
        promptRef,
        readComposerSnapshot,
        threadId,
      ],
    );
    useEffect(() => {
      const promptForThread = promptRef.current;
      const nextCursor = collapseExpandedComposerCursor(promptForThread, promptForThread.length);
      latestLocalPromptRef.current = promptForThread;
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(promptForThread, promptForThread.length));
      setComposerHighlightedItemId(null);
    }, [promptRef, threadId]);
    useEffect(() => {
      if (displayedPrompt === latestLocalPromptRef.current) {
        return;
      }
      const nextCursor = collapseExpandedComposerCursor(displayedPrompt, displayedPrompt.length);
      latestLocalPromptRef.current = displayedPrompt;
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(displayedPrompt, displayedPrompt.length));
      setComposerHighlightedItemId(null);
    }, [displayedPrompt]);
    useEffect(() => {
      if (!composerMenuOpen) {
        setComposerHighlightedItemId(null);
        return;
      }
      setComposerHighlightedItemId((existing) =>
        existing && composerMenuItems.some((item) => item.id === existing)
          ? existing
          : (composerMenuItems[0]?.id ?? null),
      );
    }, [composerMenuItems, composerMenuOpen]);

    const composerSendState = useMemo(
      () =>
        deriveComposerSendState({
          prompt: displayedPrompt,
          imageCount: composerImages.length,
          terminalContexts: composerTerminalContexts,
        }),
      [composerImages.length, composerTerminalContexts, displayedPrompt],
    );
    const composerProviderState = useMemo(
      () =>
        getComposerProviderState({
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          prompt: displayedPrompt,
          modelOptions: composerModelOptions,
        }),
      [
        composerModelOptions,
        displayedPrompt,
        selectedModel,
        selectedProvider,
        selectedProviderModels,
      ],
    );
    const selectedModelForPickerWithCustomFallback = useMemo(() => {
      return selectedProviderModels.some((option) => option.slug === selectedModel)
        ? selectedModel
        : (normalizeModelSlug(selectedModel, selectedProvider) ?? selectedModel);
    }, [selectedModel, selectedProvider, selectedProviderModels]);
    const providerTraitsMenuContent = renderProviderTraitsMenuContent({
      provider: selectedProvider,
      threadId,
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedProvider],
      prompt: displayedPrompt,
      onPromptChange: handlePromptChangeFromTraits,
    });
    const providerTraitsPicker = renderProviderTraitsPicker({
      provider: selectedProvider,
      threadId,
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedProvider],
      prompt: displayedPrompt,
      onPromptChange: handlePromptChangeFromTraits,
    });
    const nonPersistedComposerImageIdSet = useMemo(
      () => new Set(nonPersistedComposerImageIds),
      [nonPersistedComposerImageIds],
    );
    const showPlanFollowUpPrompt =
      pendingUserInputs.length === 0 && Boolean(activeProposedPlan) && interactionMode === "plan";
    const hasComposerHeader =
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      (showPlanFollowUpPrompt && activeProposedPlan !== null);

    return (
      <div className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}>
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="mx-auto w-full min-w-0 max-w-[52rem]"
          data-chat-composer-form="true"
        >
          <div
            className={cn(
              "group rounded-[22px] p-px transition-colors duration-200",
              composerProviderState.composerFrameClassName,
            )}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <div
              className={cn(
                "rounded-[20px] border bg-card transition-colors duration-200 has-focus-visible:border-ring/45",
                isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
                composerProviderState.composerSurfaceClassName,
              )}
            >
              {activePendingApproval ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovalsCount}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onSelectOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : null}
              <div
                className={cn(
                  "relative px-3 pb-2 sm:px-4",
                  hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                )}
              >
                {composerMenuOpen && !isComposerApprovalState && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                    <ComposerCommandMenu
                      items={composerMenuItems}
                      resolvedTheme={resolvedTheme}
                      isLoading={isComposerMenuLoading}
                      triggerKind={composerTriggerKind}
                      activeItemId={activeComposerMenuItem?.id ?? null}
                      onHighlightedItemChange={setComposerHighlightedItemId}
                      onSelect={handleSelectComposerItem}
                    />
                  </div>
                )}

                {!isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerImages.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {composerImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(composerImages, image.id);
                                if (preview) {
                                  onImageExpand(preview);
                                }
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                  >
                                    <CircleAlertIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                            onClick={() => onRemoveComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                <ComposerPromptEditor
                  ref={composerEditorRef}
                  value={displayedPrompt}
                  cursor={composerCursor}
                  terminalContexts={
                    !isComposerApprovalState && pendingUserInputs.length === 0
                      ? composerTerminalContexts
                      : []
                  }
                  onRemoveTerminalContext={handleRemoveTerminalContext}
                  onChange={handleComposerPromptChange}
                  onCommandKeyDown={handleComposerCommandKey}
                  onPaste={onComposerPaste}
                  placeholder={
                    isComposerApprovalState
                      ? (activePendingApproval?.detail ??
                        "Resolve this approval request to continue")
                      : activePendingProgress
                        ? "Type your own answer, or leave this blank to use the selected option"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : phase === "disconnected"
                            ? "Ask for follow-up changes or attach images"
                            : "Ask anything, @tag files/folders, or use / to show available commands"
                  }
                  disabled={isConnecting || isComposerApprovalState}
                />
              </div>

              {activePendingApproval ? (
                <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  ref={composerFooterRef}
                  data-chat-composer-footer="true"
                  data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                  className={cn(
                    "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-hidden px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                    isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                  )}
                >
                  <div
                    ref={composerFooterLeadingRef}
                    className={cn(
                      "flex min-w-0 flex-1 items-center",
                      isComposerFooterCompact
                        ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                    )}
                  >
                    <ProviderModelPicker
                      compact={isComposerFooterCompact}
                      provider={selectedProvider}
                      model={selectedModelForPickerWithCustomFallback}
                      lockedProvider={lockedProvider}
                      providers={providerStatuses}
                      modelOptionsByProvider={modelOptionsByProvider}
                      {...(composerProviderState.modelPickerIconClassName
                        ? {
                            activeProviderIconClassName:
                              composerProviderState.modelPickerIconClassName,
                          }
                        : {})}
                      onProviderModelChange={onProviderModelSelect}
                    />

                    {isComposerFooterCompact ? (
                      <CompactComposerControlsMenu
                        activePlan={Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)}
                        interactionMode={interactionMode}
                        planSidebarOpen={planSidebarOpen}
                        runtimeMode={runtimeMode}
                        traitsMenuContent={providerTraitsMenuContent}
                        onToggleInteractionMode={toggleInteractionMode}
                        onTogglePlanSidebar={togglePlanSidebar}
                        onToggleRuntimeMode={() =>
                          void handleRuntimeModeChange(
                            runtimeMode === "full-access" ? "approval-required" : "full-access",
                          )
                        }
                      />
                    ) : (
                      <>
                        {providerTraitsPicker ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            {providerTraitsPicker}
                          </>
                        ) : null}

                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                        <Button
                          variant="ghost"
                          className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                          size="sm"
                          type="button"
                          onClick={toggleInteractionMode}
                        >
                          <BotIcon />
                          <span className="sr-only sm:not-sr-only">
                            {interactionMode === "plan" ? "Plan" : "Chat"}
                          </span>
                        </Button>

                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                        <Button
                          variant="ghost"
                          className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                          size="sm"
                          type="button"
                          onClick={() =>
                            void handleRuntimeModeChange(
                              runtimeMode === "full-access" ? "approval-required" : "full-access",
                            )
                          }
                        >
                          {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                          <span className="sr-only sm:not-sr-only">
                            {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                          </span>
                        </Button>

                        {activePlan || sidebarProposedPlan || planSidebarOpen ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            <Button
                              variant="ghost"
                              className={cn(
                                "shrink-0 whitespace-nowrap px-2 sm:px-3",
                                planSidebarOpen
                                  ? "text-blue-400 hover:text-blue-300"
                                  : "text-muted-foreground/70 hover:text-foreground/80",
                              )}
                              size="sm"
                              type="button"
                              onClick={togglePlanSidebar}
                            >
                              <ListTodoIcon />
                              <span className="sr-only sm:not-sr-only">Plan</span>
                            </Button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>

                  <div
                    ref={composerFooterActionsRef}
                    data-chat-composer-actions="right"
                    data-chat-composer-primary-actions-compact={
                      isComposerPrimaryActionsCompact ? "true" : "false"
                    }
                    className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                  >
                    {activeContextWindow ? (
                      <ContextWindowMeter usage={activeContextWindow} />
                    ) : null}
                    {isPreparingWorktree ? (
                      <span className="text-muted-foreground/70 text-xs">
                        Preparing worktree...
                      </span>
                    ) : null}
                    <ComposerPrimaryActions
                      compact={isComposerPrimaryActionsCompact}
                      pendingAction={
                        activePendingProgress
                          ? {
                              questionIndex: activePendingProgress.questionIndex,
                              isLastQuestion: activePendingProgress.isLastQuestion,
                              canAdvance: activePendingProgress.canAdvance,
                              isResponding: activePendingIsResponding,
                              isComplete: Boolean(activePendingResolvedAnswers),
                            }
                          : null
                      }
                      isRunning={phase === "running"}
                      showPlanFollowUpPrompt={
                        pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                      }
                      promptHasText={displayedPrompt.trim().length > 0}
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isPreparingWorktree={isPreparingWorktree}
                      hasSendableContent={composerSendState.hasSendableContent}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={() => void onInterrupt()}
                      onImplementPlanInNewThread={() => void onImplementPlanInNewThread()}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    );
  }),
);

const ChatView = memo(function ChatView({ threadId }: ChatViewProps) {
  const serverThreadShellSelection = useStore(
    useShallow((state): ActiveThreadShellSelectorResult | undefined => {
      const thread = selectThreadById(threadId)(state);
      if (!thread) {
        return undefined;
      }
      const latestTurn = thread.latestTurn;
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        error: thread.error,
        createdAt: thread.createdAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        session: thread.session,
        hasMessages: thread.messages.length > 0,
        latestTurnAssistantMessageId: latestTurn?.assistantMessageId ?? null,
        latestTurnCompletedAt: latestTurn?.completedAt ?? null,
        latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
        latestTurnSourcePlanId: latestTurn?.sourceProposedPlan?.planId ?? null,
        latestTurnSourcePlanThreadId: latestTurn?.sourceProposedPlan?.threadId ?? null,
        latestTurnStartedAt: latestTurn?.startedAt ?? null,
        latestTurnState: latestTurn?.state ?? null,
        latestTurnTurnId: latestTurn?.turnId ?? null,
      };
    }),
  );
  const serverThreadShell = useMemo<ActiveThreadShell | undefined>(() => {
    if (!serverThreadShellSelection) {
      return undefined;
    }

    const {
      latestTurnAssistantMessageId,
      latestTurnCompletedAt,
      latestTurnRequestedAt,
      latestTurnSourcePlanId,
      latestTurnSourcePlanThreadId,
      latestTurnStartedAt,
      latestTurnState,
      latestTurnTurnId,
      ...threadShell
    } = serverThreadShellSelection;

    return {
      ...threadShell,
      latestTurn:
        latestTurnTurnId && latestTurnState && latestTurnRequestedAt
          ? {
              turnId: latestTurnTurnId,
              state: latestTurnState,
              requestedAt: latestTurnRequestedAt,
              startedAt: latestTurnStartedAt,
              completedAt: latestTurnCompletedAt,
              assistantMessageId: latestTurnAssistantMessageId,
              ...(latestTurnSourcePlanId && latestTurnSourcePlanThreadId
                ? {
                    sourceProposedPlan: {
                      planId: latestTurnSourcePlanId,
                      threadId: latestTurnSourcePlanThreadId,
                    },
                  }
                : {}),
            }
          : null,
    };
  }, [serverThreadShellSelection]);
  const threadActivities = useStore(
    useMemo(
      () => (state) => selectThreadById(threadId)(state)?.activities ?? EMPTY_ACTIVITIES,
      [threadId],
    ),
  );
  const threadProposedPlans = useStore(
    useMemo(
      () => (state) => selectThreadById(threadId)(state)?.proposedPlans ?? EMPTY_PROPOSED_PLANS,
      [threadId],
    ),
  );
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadId],
  );
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraftSelections = useComposerDraftStore(
    useShallow((store) => {
      const draft = store.draftsByThreadId[threadId];
      return {
        activeProvider: draft?.activeProvider ?? null,
        modelSelectionByProvider: draft?.modelSelectionByProvider ?? null,
        runtimeMode: draft?.runtimeMode ?? null,
        interactionMode: draft?.interactionMode ?? null,
      };
    }),
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const initialComposerDraft = getComposerThreadDraftSnapshot(threadId);
  const promptRef = useRef(initialComposerDraft.prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(
    initialComposerDraft.terminalContexts,
  );
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [pendingPullRequestSetupRequest, setPendingPullRequestSetupRequest] =
    useState<PendingPullRequestSetupRequest | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const timelinePaneRef = useRef<TimelinePaneHandle>(null);
  const composerPaneRef = useRef<ComposerPaneHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerFooterRef = useRef<HTMLDivElement>(null);
  const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
  const composerFooterActionsRef = useRef<HTMLDivElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>(initialComposerDraft.images);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      composerImagesRef.current = [...composerImagesRef.current, image];
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      if (images.length > 0) {
        composerImagesRef.current = [...composerImagesRef.current, ...images];
      }
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      if (contexts.length > 0) {
        composerTerminalContextsRef.current = [...composerTerminalContextsRef.current, ...contexts];
      }
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      composerImagesRef.current = composerImagesRef.current.filter((image) => image.id !== imageId);
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );

  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThreadShell ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThreadShell ?? localDraftThread;
  const runtimeMode =
    composerDraftSelections.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraftSelections.interactionMode ??
    activeThread?.interactionMode ??
    DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThreadShell !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadHasMessages = isServerThread
    ? (serverThreadShell?.hasMessages ?? false)
    : false;
  const getActiveThreadSnapshot = useCallback((): Thread | undefined => {
    const storeState = useStore.getState();
    const serverThread = selectThreadById(threadId)(storeState);
    if (serverThread) {
      return serverThread;
    }

    const currentDraftThread = useComposerDraftStore.getState().draftThreadsByThreadId[threadId];
    if (!currentDraftThread) {
      return undefined;
    }

    const fallbackProject = selectProjectById(currentDraftThread.projectId)(storeState);
    return buildLocalDraftThread(
      threadId,
      currentDraftThread,
      fallbackProject?.defaultModelSelection ?? {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
      localDraftErrorsByThreadId[threadId] ?? null,
    );
  }, [localDraftErrorsByThreadId, threadId]);
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = useProjectById(activeThread?.projectId);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, input);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return storedDraftThread.threadId;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (!isServerThread && activeDraftThread?.projectId === activeProject.id) {
        setDraftThreadContext(threadId, input);
        setProjectDraftThreadId(activeProject.id, threadId, input);
        return threadId;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
      return nextThreadId;
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      const targetThreadId = await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
      const setupScript =
        input.worktreePath && activeProject ? setupProjectScript(activeProject.scripts) : null;
      if (targetThreadId && input.worktreePath && setupScript) {
        setPendingPullRequestSetupRequest({
          threadId: targetThreadId,
          worktreePath: input.worktreePath,
          scriptId: setupScript.id,
        });
      } else {
        setPendingPullRequestSetupRequest(null);
      }
    },
    [activeProject, openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThreadShell?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(serverThreadShell.id);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThreadShell?.id,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraftSelections.activeProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null || activeThreadHasMessages || activeThread.session !== null),
  );
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const providerStatuses = useServerProviders();
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;
  const composerModelDraft = useMemo(
    () =>
      composerDraftSelections.modelSelectionByProvider || composerDraftSelections.activeProvider
        ? {
            modelSelectionByProvider: composerDraftSelections.modelSelectionByProvider ?? {},
            activeProvider: composerDraftSelections.activeProvider,
          }
        : null,
    [composerDraftSelections.activeProvider, composerDraftSelections.modelSelectionByProvider],
  );
  const { modelOptions: composerModelOptions, selectedModel } = useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft: composerModelDraft,
        providers: providerStatuses,
        selectedProvider,
        threadModelSelection: activeThread?.modelSelection,
        projectModelSelection: activeProject?.defaultModelSelection,
        settings,
      }),
    [
      activeProject?.defaultModelSelection,
      activeThread?.modelSelection,
      composerModelDraft,
      providerStatuses,
      selectedProvider,
      settings,
    ],
  );
  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const getComposerProviderStateSnapshot = useCallback(
    (prompt: string) =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, selectedModel, selectedProvider, selectedProviderModels],
  );
  const getSelectedModelSelection = useCallback(
    (prompt: string): ModelSelection => {
      const providerState = getComposerProviderStateSnapshot(prompt);
      return {
        provider: selectedProvider,
        model: selectedModel,
        ...(providerState.modelOptionsForDispatch
          ? { options: providerState.modelOptionsForDispatch }
          : {}),
      };
    },
    [getComposerProviderStateSnapshot, selectedModel, selectedProvider],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(threadProposedPlans, activeLatestTurn?.turnId ?? null);
  }, [activeLatestTurn?.turnId, latestTurnSettled, threadProposedPlans]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const isComposerApprovalState = activePendingApproval !== null;
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = activePendingProgress
    ? `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`
    : phase === "running"
      ? "running"
      : showPlanFollowUpPrompt
        ? "plan"
        : `idle:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const branchesQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const keybindings = useServerKeybindings();
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, navigate, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThreadHasMessages ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (useStore.getState().threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    composerPaneRef.current?.focusAtEnd();
  }, []);
  const addTerminalContextToComposer = useCallback((selection: TerminalContextSelection) => {
    composerPaneRef.current?.insertTerminalContext(selection);
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );

  useEffect(() => {
    if (!pendingPullRequestSetupRequest || !activeProject || !activeThreadId || !activeThread) {
      return;
    }
    if (pendingPullRequestSetupRequest.threadId !== activeThreadId) {
      return;
    }
    if (activeThread.worktreePath !== pendingPullRequestSetupRequest.worktreePath) {
      return;
    }

    const setupScript =
      activeProject.scripts.find(
        (script) => script.id === pendingPullRequestSetupRequest.scriptId,
      ) ?? null;
    setPendingPullRequestSetupRequest(null);
    if (!setupScript) {
      return;
    }

    void runProjectScript(setupScript, {
      cwd: pendingPullRequestSetupRequest.worktreePath,
      worktreePath: pendingPullRequestSetupRequest.worktreePath,
      rememberAsLastInvoked: false,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to run setup script.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [
    activeProject,
    activeThread,
    activeThreadId,
    pendingPullRequestSetupRequest,
    runProjectScript,
  ]);
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
      }
    },
    [],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
        if (turnKey) {
          planSidebarDismissedForTurnRef.current = turnKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThreadShell) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThreadShell.modelSelection.model ||
          input.modelSelection.provider !== serverThreadShell.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThreadShell.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverThreadShell.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThreadShell.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThreadShell],
  );

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const footer = composerFooterRef.current;
      const footerStyle = footer ? window.getComputedStyle(footer) : null;
      const footerContentWidth = resolveComposerFooterContentWidth({
        footerWidth: footer?.clientWidth ?? null,
        paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
        paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
      });
      const fitInput = {
        footerContentWidth,
        leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
        actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
      };
      const nextFooterCompact =
        heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
      const nextPrimaryActionsCompact =
        nextFooterCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });

      return {
        primaryActionsCompact: nextPrimaryActionsCompact,
        footerCompact: nextFooterCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      timelinePaneRef.current?.forceStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterActionLayoutKey, composerFooterHasWideActions]);

  useEffect(() => {
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;

    let removalTimer: number | null = null;
    const reconcileOptimisticMessages = (state: ReturnType<typeof useStore.getState>) => {
      const serverMessages =
        selectThreadById(activeThread.id)(state)?.messages ?? EMPTY_CHAT_MESSAGES;
      if (serverMessages.length === 0) {
        return;
      }
      const serverIds = new Set(serverMessages.map((message) => message.id));
      const removedMessages = optimisticUserMessagesRef.current.filter((message) =>
        serverIds.has(message.id),
      );
      if (removedMessages.length === 0) {
        return;
      }

      if (removalTimer !== null) {
        window.clearTimeout(removalTimer);
      }
      removalTimer = window.setTimeout(() => {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => !serverIds.has(message.id)),
        );
      }, 0);

      for (const removedMessage of removedMessages) {
        const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
        if (previewUrls.length > 0) {
          handoffAttachmentPreviews(removedMessage.id, previewUrls);
          continue;
        }
        revokeUserMessagePreviewUrls(removedMessage);
      }
    };

    const unsubscribe = useStore.subscribe((state) => {
      reconcileOptimisticMessages(state);
    });

    reconcileOptimisticMessages(useStore.getState());

    return () => {
      if (removalTimer !== null) {
        window.clearTimeout(removalTimer);
      }
      unsubscribe();
    };
  }, [activeThread?.id, handoffAttachmentPreviews]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleTerminalVisibility,
  ]);

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, isConnecting, isRevertingCheckpoint, isSendBusy, phase, setThreadError],
  );

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    const currentActiveThread = getActiveThreadSnapshot();
    if (!api || !currentActiveThread || isSendBusy || isConnecting || sendInFlightRef.current) {
      return;
    }
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const promptForSend = promptRef.current;
    const composerImages = composerImagesRef.current;
    const composerTerminalContexts = composerTerminalContextsRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(currentActiveThread.id);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(currentActiveThread.id);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    const threadIdForSend = currentActiveThread.id;
    const isFirstMessage = !isServerThread || currentActiveThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !currentActiveThread.worktreePath
        ? currentActiveThread.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !currentActiveThread.worktreePath;
    if (shouldCreateWorktree && !currentActiveThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const selectedModelSelection = getSelectedModelSelection(promptForSend);
    const selectedPromptEffort = getComposerProviderStateSnapshot(promptForSend).promptEffort;
    const outgoingMessageText = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    timelinePaneRef.current?.forceStickToBottom();

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let nextThreadBranch = currentActiveThread.branch;
    let nextThreadWorktreePath = currentActiveThread.worktreePath;
    await (async () => {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        beginLocalDispatch({ preparingWorktree: true });
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          setStoreThreadBranch(threadIdForSend, result.worktree.branch, result.worktree.path);
        }
      }

      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection: ModelSelection = {
        provider: selectedProvider,
        model:
          selectedModel ||
          activeProject.defaultModelSelection?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        ...(selectedModelSelection.options ? { options: selectedModelSelection.options } : {}),
      };

      if (isLocalDraftThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          modelSelection: threadCreateModelSelection,
          runtimeMode,
          interactionMode,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: currentActiveThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
      }

      let setupScript: ProjectScript | null = null;
      if (baseBranchForWorktree) {
        setupScript = setupProjectScript(activeProject.scripts);
      }
      if (setupScript) {
        let shouldRunSetupScript = false;
        if (isServerThread) {
          shouldRunSetupScript = true;
        } else {
          if (createdServerThreadForLocalDraft) {
            shouldRunSetupScript = true;
          }
        }
        if (shouldRunSetupScript) {
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          await runProjectScript(setupScript, setupScriptOptions);
        }
      }

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { modelSelection: selectedModelSelection } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      beginLocalDispatch({ preparingWorktree: false });
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: selectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
  };

  const onInterrupt = async () => {
    const api = readNativeApi();
    const currentActiveThread = getActiveThreadSnapshot();
    if (!api || !currentActiveThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: currentActiveThread.id,
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: {
            selectedOptionLabel: optionLabel,
            customAnswer: "",
          },
        },
      }));
      promptRef.current = "";
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (questionId: string, value: string) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      const currentActiveThread = getActiveThreadSnapshot();
      if (
        !api ||
        !currentActiveThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const threadIdForSend = currentActiveThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const selectedModelSelection = getSelectedModelSelection(trimmed);
      const selectedPromptEffort = getComposerProviderStateSnapshot(trimmed).promptEffort;
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      timelinePaneRef.current?.forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: currentActiveThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: currentActiveThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeProposedPlan,
      beginLocalDispatch,
      getActiveThreadSnapshot,
      getComposerProviderStateSnapshot,
      getSelectedModelSelection,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      selectedProvider,
      selectedProviderModels,
      setComposerDraftInteractionMode,
      setThreadError,
      selectedModel,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    const currentActiveThread = getActiveThreadSnapshot();
    if (
      !api ||
      !currentActiveThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const selectedModelSelection = getSelectedModelSelection(implementationPrompt);
    const selectedPromptEffort =
      getComposerProviderStateSnapshot(implementationPrompt).promptEffort;
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: currentActiveThread.branch,
        worktreePath: currentActiveThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: currentActiveThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(nextThreadId);
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    beginLocalDispatch,
    getActiveThreadSnapshot,
    getComposerProviderStateSnapshot,
    getSelectedModelSelection,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: string) => {
      const currentActiveThread = getActiveThreadSnapshot();
      if (!currentActiveThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
      const resolvedModel = resolveAppModelSelection(
        resolvedProvider,
        settings,
        providerStatuses,
        model,
      );
      const nextModelSelection: ModelSelection = {
        provider: resolvedProvider,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(currentActiveThread.id, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      getActiveThreadSnapshot,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, threadId],
  );
  const handleComposerSend = useStableCallback(onSend);
  const handleComposerPaste = useStableCallback(onComposerPaste);
  const handleComposerDragEnter = useStableCallback(onComposerDragEnter);
  const handleComposerDragOver = useStableCallback(onComposerDragOver);
  const handleComposerDragLeave = useStableCallback(onComposerDragLeave);
  const handleComposerDrop = useStableCallback(onComposerDrop);
  const handleSelectActivePendingUserInputOption = useStableCallback(
    onSelectActivePendingUserInputOption,
  );
  const handleAdvanceActivePendingUserInput = useStableCallback(onAdvanceActivePendingUserInput);
  const handlePreviousActivePendingUserInputQuestion = useStableCallback(
    onPreviousActivePendingUserInputQuestion,
  );
  const handlePendingUserInputCustomAnswerChange = useStableCallback(
    onChangeActivePendingUserInputCustomAnswer,
  );
  const handleRespondToApproval = useStableCallback(onRespondToApproval);
  const handleInterrupt = useStableCallback(onInterrupt);
  const handleImplementPlanInNewThread = useStableCallback(onImplementPlanInNewThread);
  const handleRemoveComposerImage = useStableCallback(removeComposerImage);
  const handleExpandTimelineImage = useStableCallback(onExpandTimelineImage);
  const handleProviderModelSelect = useStableCallback(onProviderModelSelect);
  const handleInteractionModeChangeStable = useStableCallback(handleInteractionModeChange);
  const handleToggleInteractionMode = useStableCallback(toggleInteractionMode);
  const handleTogglePlanSidebar = useStableCallback(togglePlanSidebar);
  const handleRuntimeModeChangeStable = useStableCallback(handleRuntimeModeChange);
  const handleRunProjectScript = useStableCallback(runProjectScript);
  const handleSaveProjectScript = useStableCallback(saveProjectScript);
  const handleUpdateProjectScript = useStableCallback(updateProjectScript);
  const handleDeleteProjectScript = useStableCallback(deleteProjectScript);
  const handleToggleTerminalVisibility = useStableCallback(toggleTerminalVisibility);
  const handleToggleDiff = useStableCallback(onToggleDiff);
  const handleEnvModeChange = useStableCallback(onEnvModeChange);
  const handleScheduleComposerFocus = useStableCallback(scheduleComposerFocus);
  const handleOpenPullRequestDialog = useStableCallback(openPullRequestDialog);

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <ChatHeaderPane
          threadId={activeThread.id}
          preferredScriptIdByProjectId={lastInvokedScriptByProjectId}
          diffOpen={diffOpen}
          onRunProjectScript={handleRunProjectScript}
          onAddProjectScript={handleSaveProjectScript}
          onUpdateProjectScript={handleUpdateProjectScript}
          onDeleteProjectScript={handleDeleteProjectScript}
          onToggleTerminal={handleToggleTerminalVisibility}
          onToggleDiff={handleToggleDiff}
        />
      </header>

      {/* Error banner */}
      <ProviderStatusBanner status={activeProviderStatus} />
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TimelinePane
            ref={timelinePaneRef}
            threadId={activeThread.id}
            optimisticUserMessages={optimisticUserMessages}
            attachmentPreviewHandoffByMessageId={attachmentPreviewHandoffByMessageId}
            isWorking={isWorking}
            localDispatchStartedAt={localDispatchStartedAt}
            onOpenTurnDiff={onOpenTurnDiff}
            onRevertToTurnCount={onRevertToTurnCount}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onExpandTimelineImage}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
          />

          {/* Input bar */}
          <ComposerPane
            threadId={activeThread.id}
            phase={phase}
            gitCwd={gitCwd}
            isGitRepo={isGitRepo}
            isDragOverComposer={isDragOverComposer}
            resolvedTheme={resolvedTheme}
            composerFormRef={composerFormRef}
            composerFooterRef={composerFooterRef}
            composerFooterLeadingRef={composerFooterLeadingRef}
            composerFooterActionsRef={composerFooterActionsRef}
            promptRef={promptRef}
            composerImagesRef={composerImagesRef}
            composerTerminalContextsRef={composerTerminalContextsRef}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            selectedProviderModels={selectedProviderModels}
            providerStatuses={providerStatuses}
            composerModelOptions={composerModelOptions}
            lockedProvider={lockedProvider}
            interactionMode={interactionMode}
            runtimeMode={runtimeMode}
            activePlan={activePlan}
            sidebarProposedPlan={sidebarProposedPlan}
            planSidebarOpen={planSidebarOpen}
            activeProposedPlan={activeProposedPlan}
            activePendingApproval={activePendingApproval}
            pendingApprovalsCount={pendingApprovals.length}
            pendingUserInputs={pendingUserInputs}
            respondingRequestIds={respondingRequestIds}
            activePendingDraftAnswers={activePendingDraftAnswers}
            activePendingQuestionIndex={activePendingQuestionIndex}
            activePendingProgress={activePendingProgress}
            activePendingResolvedAnswers={activePendingResolvedAnswers}
            activePendingIsResponding={activePendingIsResponding}
            activeContextWindow={activeContextWindow}
            isComposerApprovalState={isComposerApprovalState}
            isPreparingWorktree={isPreparingWorktree}
            isSendBusy={isSendBusy}
            isConnecting={isConnecting}
            isComposerFooterCompact={isComposerFooterCompact}
            isComposerPrimaryActionsCompact={isComposerPrimaryActionsCompact}
            onSend={handleComposerSend}
            onPendingUserInputCustomAnswerChange={handlePendingUserInputCustomAnswerChange}
            onComposerPaste={handleComposerPaste}
            onComposerDragEnter={handleComposerDragEnter}
            onComposerDragOver={handleComposerDragOver}
            onComposerDragLeave={handleComposerDragLeave}
            onComposerDrop={handleComposerDrop}
            onSelectActivePendingUserInputOption={handleSelectActivePendingUserInputOption}
            onAdvanceActivePendingUserInput={handleAdvanceActivePendingUserInput}
            onPreviousActivePendingUserInputQuestion={handlePreviousActivePendingUserInputQuestion}
            onRespondToApproval={handleRespondToApproval}
            onInterrupt={handleInterrupt}
            onImplementPlanInNewThread={handleImplementPlanInNewThread}
            onRemoveComposerImage={handleRemoveComposerImage}
            onImageExpand={handleExpandTimelineImage}
            onProviderModelSelect={handleProviderModelSelect}
            onInteractionModeChange={handleInteractionModeChangeStable}
            toggleInteractionMode={handleToggleInteractionMode}
            togglePlanSidebar={handleTogglePlanSidebar}
            handleRuntimeModeChange={handleRuntimeModeChangeStable}
          />

          {isGitRepo && (
            <BranchToolbar
              threadId={activeThread.id}
              onEnvModeChange={handleEnvModeChange}
              envLocked={envLocked}
              onComposerFocusRequest={handleScheduleComposerFocus}
              {...(canCheckoutPullRequestIntoThread
                ? { onCheckoutPullRequestRequest: handleOpenPullRequestDialog }
                : {})}
            />
          )}
          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeProject?.cwd ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {(() => {
        if (!terminalState.terminalOpen || !activeProject) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
            threadId={activeThread.id}
            cwd={gitCwd ?? activeProject.cwd}
            runtimeEnv={threadTerminalRuntimeEnv}
            height={terminalState.terminalHeight}
            terminalIds={terminalState.terminalIds}
            activeTerminalId={terminalState.activeTerminalId}
            terminalGroups={terminalState.terminalGroups}
            activeTerminalGroupId={terminalState.activeTerminalGroupId}
            focusRequestId={terminalFocusRequestId}
            onSplitTerminal={splitTerminal}
            onNewTerminal={createNewTerminal}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            onActiveTerminalChange={activateTerminal}
            onCloseTerminal={closeTerminal}
            onHeightChange={setTerminalHeight}
            onAddTerminalContext={addTerminalContextToComposer}
          />
        );
      })()}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-zoom-out"
            aria-label="Close image preview"
            onClick={closeExpandedImage}
          />
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={() => {
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={() => {
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

export default ChatView;
