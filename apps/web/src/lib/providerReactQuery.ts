import {
  type EnvironmentId,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffViewInput,
  type OrchestrationTurnDiffScope,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "../environmentApi";

interface CheckpointDiffQueryInput {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  ignoreWhitespace: boolean;
  cacheScope?: string | null;
  enabled?: boolean;
}

interface TurnDiffViewQueryInput {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  mode: "completed" | "live";
  ignoreWhitespace: boolean;
  scope?: OrchestrationTurnDiffScope | null;
  revisionKey?: string | null;
  enabled?: boolean;
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.environmentId ?? null,
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.ignoreWhitespace,
      input.cacheScope ?? null,
    ] as const,
  turnDiffView: (input: TurnDiffViewQueryInput) =>
    [
      "providers",
      "turnDiffView",
      input.environmentId ?? null,
      input.threadId,
      input.turnId,
      input.mode,
      input.ignoreWhitespace,
      input.scope ?? null,
      input.revisionKey ?? null,
    ] as const,
};

function decodeCheckpointDiffRequest(input: CheckpointDiffQueryInput) {
  const { threadId, fromTurnCount, toTurnCount, ignoreWhitespace } = input;
  if (threadId === null) {
    return null;
  }
  if (
    typeof toTurnCount !== "number" ||
    !Number.isInteger(toTurnCount) ||
    toTurnCount < 0 ||
    typeof fromTurnCount !== "number" ||
    !Number.isInteger(fromTurnCount) ||
    fromTurnCount < 0
  ) {
    return null;
  }

  if (fromTurnCount === 0) {
    return {
      kind: "fullThreadDiff" as const,
      input: {
        threadId,
        toTurnCount,
        ignoreWhitespace,
      } satisfies OrchestrationGetFullThreadDiffInput,
    };
  }

  if (fromTurnCount > toTurnCount) {
    return null;
  }

  return {
    kind: "turnDiff" as const,
    input: {
      threadId,
      fromTurnCount,
      toTurnCount,
      ignoreWhitespace,
    } satisfies OrchestrationGetTurnDiffInput,
  };
}

function decodeTurnDiffViewRequest(input: TurnDiffViewQueryInput) {
  if (input.threadId === null || input.turnId === null) {
    return null;
  }

  return {
    threadId: input.threadId,
    turnId: input.turnId,
    mode: input.mode,
    ignoreWhitespace: input.ignoreWhitespace,
    ...(input.scope ? { scope: input.scope } : {}),
  } satisfies OrchestrationGetTurnDiffViewInput;
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

export function checkpointDiffQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeCheckpointDiffRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async () => {
      if (!input.environmentId || !input.threadId || decodedRequest === null) {
        throw new Error("Checkpoint diff is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      try {
        if (decodedRequest.kind === "fullThreadDiff") {
          return await api.orchestration.getFullThreadDiff(decodedRequest.input);
        }
        return await api.orchestration.getTurnDiff(decodedRequest.input);
      } catch (error) {
        throw new Error(normalizeCheckpointErrorMessage(error), { cause: error });
      }
    },
    enabled:
      (input.enabled ?? true) &&
      !!input.environmentId &&
      !!input.threadId &&
      decodedRequest !== null,
    staleTime: Infinity,
    retry: (failureCount, error) => {
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < 12;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) =>
      isCheckpointTemporarilyUnavailable(error)
        ? Math.min(5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1)),
  });
}

export function turnDiffViewQueryOptions(input: TurnDiffViewQueryInput) {
  const decodedRequest = decodeTurnDiffViewRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.turnDiffView(input),
    queryFn: async () => {
      if (!input.environmentId || !input.threadId || decodedRequest === null) {
        throw new Error("Turn diff view is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      try {
        return await api.orchestration.getTurnDiffView(decodedRequest);
      } catch (error) {
        throw new Error(normalizeCheckpointErrorMessage(error), { cause: error });
      }
    },
    enabled:
      (input.enabled ?? true) &&
      !!input.environmentId &&
      !!input.threadId &&
      decodedRequest !== null,
    staleTime: input.mode === "live" ? 0 : Infinity,
    retry: (failureCount, error) => {
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < 12;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) =>
      isCheckpointTemporarilyUnavailable(error)
        ? Math.min(5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1)),
  });
}
