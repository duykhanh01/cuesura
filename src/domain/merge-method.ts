import { z } from 'zod';

/**
 * How a PR is merged (SPEC §14.2, task-execution-modes.md): `cusr.yaml` `merge.method`, `squash` when
 * the object or the key is absent. It is resolved from the frozen base and frozen per task; it grants
 * no merge right (yolo, approval) and is independent of the execution mode.
 *
 * Yolo merges with this method. Otherwise it is a suggestion to the person who merges, never an
 * admission check, and a manual merge with another or unknown method still completes the task.
 */
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const MergeMethodSchema = z.enum(MERGE_METHODS);

export const DEFAULT_MERGE_METHOD: MergeMethod = 'squash';

/** The method for a new task: the declared one, else the default. */
export function resolveMergeMethod(
  project: { readonly merge_method?: MergeMethod } | null | undefined,
): MergeMethod {
  return project?.merge_method ?? DEFAULT_MERGE_METHOD;
}
