import type { ModelSelection, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { deriveLogicalProjectKey, type LogicalProjectKey } from "../../logicalProject";
import type { Project, ProjectScript } from "../../types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export type SidebarProjectSnapshot = Project & {
  projectKey: LogicalProjectKey;
  environmentPresence: EnvironmentPresence;
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
};

type SavedEnvironmentRegistryEntry = {
  label?: string | null;
} | null;

type SavedEnvironmentRuntimeEntry = {
  descriptor?: {
    label?: string | null;
  } | null;
} | null;

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function refsEqual(left: readonly ScopedProjectRef[], right: readonly ScopedProjectRef[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.environmentId === right[index]?.environmentId &&
        ref.projectId === right[index]?.projectId,
    )
  );
}

function modelSelectionsEqual(left: ModelSelection | null, right: ModelSelection | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

function projectScriptsEqual(
  left: readonly ProjectScript[],
  right: readonly ProjectScript[],
): boolean {
  return (
    left.length === right.length &&
    left.every((script, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        script.id === other.id &&
        script.name === other.name &&
        script.command === other.command &&
        script.icon === other.icon &&
        script.runOnWorktreeCreate === other.runOnWorktreeCreate
      );
    })
  );
}

export function sidebarProjectSnapshotsEqual(
  left: SidebarProjectSnapshot | undefined,
  right: SidebarProjectSnapshot,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.environmentId === right.environmentId &&
    left.name === right.name &&
    left.cwd === right.cwd &&
    left.repositoryIdentity === right.repositoryIdentity &&
    modelSelectionsEqual(left.defaultModelSelection, right.defaultModelSelection) &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    projectScriptsEqual(left.scripts, right.scripts) &&
    left.projectKey === right.projectKey &&
    left.environmentPresence === right.environmentPresence &&
    refsEqual(left.memberProjectRefs, right.memberProjectRefs) &&
    stringArraysEqual(left.remoteEnvironmentLabels, right.remoteEnvironmentLabels)
  );
}

export function buildSidebarPhysicalToLogicalKeyMap(
  orderedProjects: readonly Project[],
): ReadonlyMap<string, LogicalProjectKey> {
  const mapping = new Map<string, LogicalProjectKey>();
  for (const project of orderedProjects) {
    const physicalKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    mapping.set(physicalKey, deriveLogicalProjectKey(project));
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  orderedProjects: readonly Project[];
  previousProjectSnapshotByKey: ReadonlyMap<LogicalProjectKey, SidebarProjectSnapshot>;
  primaryEnvironmentId: EnvironmentId | null;
  savedEnvironmentRegistryById: Readonly<Record<string, SavedEnvironmentRegistryEntry>>;
  savedEnvironmentRuntimeById: Readonly<Record<string, SavedEnvironmentRuntimeEntry>>;
}): {
  projectSnapshotByKey: ReadonlyMap<LogicalProjectKey, SidebarProjectSnapshot>;
  sidebarProjects: readonly SidebarProjectSnapshot[];
} {
  const {
    orderedProjects,
    previousProjectSnapshotByKey,
    primaryEnvironmentId,
    savedEnvironmentRegistryById,
    savedEnvironmentRuntimeById,
  } = input;

  const groupedMembers = new Map<LogicalProjectKey, Project[]>();
  for (const project of orderedProjects) {
    const logicalKey = deriveLogicalProjectKey(project);
    const existingMembers = groupedMembers.get(logicalKey);
    if (existingMembers) {
      existingMembers.push(project);
      continue;
    }
    groupedMembers.set(logicalKey, [project]);
  }

  const nextProjectSnapshotByKey = new Map<LogicalProjectKey, SidebarProjectSnapshot>();
  const sidebarProjects: SidebarProjectSnapshot[] = [];
  const emittedProjectKeys = new Set<LogicalProjectKey>();

  for (const project of orderedProjects) {
    const logicalKey = deriveLogicalProjectKey(project);
    if (emittedProjectKeys.has(logicalKey)) {
      continue;
    }
    emittedProjectKeys.add(logicalKey);

    const members = groupedMembers.get(logicalKey);
    if (!members || members.length === 0) {
      continue;
    }

    const representative =
      (primaryEnvironmentId
        ? members.find((member) => member.environmentId === primaryEnvironmentId)
        : undefined) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === primaryEnvironmentId);
    const hasRemote =
      primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== primaryEnvironmentId)
        : false;

    const nextSnapshot: SidebarProjectSnapshot = {
      id: representative.id,
      environmentId: representative.environmentId,
      name: representative.name,
      cwd: representative.cwd,
      repositoryIdentity: representative.repositoryIdentity ?? null,
      defaultModelSelection: representative.defaultModelSelection,
      createdAt: representative.createdAt,
      updatedAt: representative.updatedAt,
      scripts: representative.scripts,
      projectKey: logicalKey,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels: members
        .filter(
          (member) =>
            primaryEnvironmentId !== null && member.environmentId !== primaryEnvironmentId,
        )
        .map((member) => {
          const runtimeEnvironment = savedEnvironmentRuntimeById[member.environmentId];
          const savedEnvironment = savedEnvironmentRegistryById[member.environmentId];
          return (
            runtimeEnvironment?.descriptor?.label ?? savedEnvironment?.label ?? member.environmentId
          );
        }),
    };

    const cachedSnapshot = previousProjectSnapshotByKey.get(logicalKey);
    const snapshot =
      cachedSnapshot && sidebarProjectSnapshotsEqual(cachedSnapshot, nextSnapshot)
        ? cachedSnapshot
        : nextSnapshot;
    nextProjectSnapshotByKey.set(logicalKey, snapshot);
    sidebarProjects.push(snapshot);
  }

  return {
    projectSnapshotByKey:
      nextProjectSnapshotByKey.size === 0
        ? new Map<LogicalProjectKey, SidebarProjectSnapshot>()
        : nextProjectSnapshotByKey,
    sidebarProjects,
  };
}
