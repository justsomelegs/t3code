import type {
  CheckpointRef,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationCheckpointSummary,
} from "@t3tools/contracts";

export function isRealCheckpointRef(checkpointRef: CheckpointRef | string): boolean {
  return checkpointRef.startsWith("refs/t3/checkpoints/");
}

export function classifyCheckpointRef(
  checkpointRef: CheckpointRef | string,
): Pick<OrchestrationCheckpointSummary, "source" | "isRevertable" | "isFullDiffAvailable"> {
  const isRealCheckpoint = isRealCheckpointRef(checkpointRef);
  return {
    source: "checkpoint",
    isRevertable: isRealCheckpoint,
    isFullDiffAvailable: isRealCheckpoint,
  };
}

export function isStaleProviderDiffPlaceholder(input: {
  readonly checkpointRef: CheckpointRef | string;
  readonly status: OrchestrationCheckpointStatus;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
}): boolean {
  return (
    input.checkpointRef.startsWith("provider-diff:") &&
    input.status === "missing" &&
    input.files.length === 0
  );
}
