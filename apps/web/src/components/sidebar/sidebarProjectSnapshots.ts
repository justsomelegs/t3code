import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { deriveLogicalProjectKey, type LogicalProjectKey } from "../../logicalProject";
import type { Project } from "../../types";
import { sidebarProjectSnapshotsEqual, type SidebarProjectSnapshot } from "./sidebarViewStore";

type SavedEnvironmentRegistryEntry = {
  label?: string | null;
} | null;

type SavedEnvironmentRuntimeEntry = {
  descriptor?: {
    label?: string | null;
  } | null;
} | null;

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
