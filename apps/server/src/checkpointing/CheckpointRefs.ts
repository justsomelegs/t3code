import type { CheckpointRef } from "@t3tools/contracts";

export function isRealCheckpointRef(checkpointRef: CheckpointRef | string): boolean {
  return checkpointRef.startsWith("refs/t3/checkpoints/");
}

function isProviderDiffCheckpointRef(checkpointRef: CheckpointRef | string): boolean {
  return checkpointRef.startsWith("provider-diff:");
}

export function isLegacyProviderDiffCheckpoint(checkpointRef: CheckpointRef | string): boolean {
  return isProviderDiffCheckpointRef(checkpointRef);
}
