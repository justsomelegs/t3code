import type { CheckpointRef, OrchestrationCheckpointSummary } from "@t3tools/contracts";

export function isRealCheckpointRef(checkpointRef: CheckpointRef | string): boolean {
  return checkpointRef.startsWith("refs/t3/checkpoints/");
}

export function classifyCheckpointRef(
  checkpointRef: CheckpointRef | string,
): Pick<OrchestrationCheckpointSummary, "source" | "isRevertable" | "isFullDiffAvailable"> {
  const source = checkpointRef.startsWith("provider-diff:") ? "legacy-provider-diff" : "checkpoint";
  const isRealCheckpoint = source === "checkpoint" && isRealCheckpointRef(checkpointRef);
  return {
    source,
    isRevertable: isRealCheckpoint,
    isFullDiffAvailable: isRealCheckpoint,
  };
}
