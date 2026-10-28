import fs from 'fs';
import path from 'path';
import type { LauncherPlan, LauncherRecord } from './launcher';
import { atomicJSON } from '../github/stack_file';

export type Implementation = 'gt-gh' | 'graphite';
export type ImplementationSelection = {
  mode: Implementation;
  worktrees: string[];
};

export function validSelections(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([common, entry]) => {
    const selection = entry as ImplementationSelection;
    return (
      path.isAbsolute(common) &&
      selection &&
      ['gt-gh', 'graphite'].includes(selection.mode) &&
      Array.isArray(selection.worktrees) &&
      selection.worktrees.every(
        (root) => typeof root === 'string' && path.isAbsolute(root)
      )
    );
  });
}

export function implementationFor(
  record: LauncherRecord | undefined,
  common?: string
): Implementation | undefined {
  return (
    (common
      ? record?.implementations?.[fs.realpathSync(common)]?.mode
      : undefined) ??
    record?.defaultMode ??
    (record ? 'graphite' : undefined)
  );
}

/** Selector bookkeeping is independent of initialized-repository handoff records. */
export function saveImplementation(
  plan: LauncherPlan,
  record: LauncherRecord,
  selection: { common: string; mode: Implementation; worktrees: string[] }
): LauncherRecord {
  const common = fs.realpathSync(selection.common);
  const previous = record.implementations?.[common];
  const updated = {
    ...record,
    implementations: {
      ...record.implementations,
      [common]: {
        mode: selection.mode,
        worktrees: [
          ...new Set([...(previous?.worktrees ?? []), ...selection.worktrees]),
        ],
      },
    },
  };
  atomicJSON(path.join(plan.directory, 'launcher.json'), updated);
  return updated;
}

/** Global disable retains its established "return everything to native" contract. */
export function clearCloneSelections(plan: LauncherPlan): void {
  if (!plan.record?.implementations) return;
  plan.record.implementations = Object.fromEntries(
    Object.entries(plan.record.implementations).filter(
      ([, selection]) => selection.mode !== 'gt-gh'
    )
  );
  atomicJSON(path.join(plan.directory, 'launcher.json'), plan.record);
}
