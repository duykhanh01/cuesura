import type { Hash } from '../shared/brand.ts';
import type { Workflow } from '../domain/workflow.ts';
import { SOFTWARE_DEV } from '../engine/workflows/software-dev.ts';
import { structureHash } from './structure-hash.ts';

export const SOFTWARE_DEV_STRUCTURE: Hash = structureHash(SOFTWARE_DEV);

export function isSupportedStructure(w: Workflow): boolean {
  return structureHash(w) === SOFTWARE_DEV_STRUCTURE;
}
