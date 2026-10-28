/**
 * CPU-bound property runs take ~20 s alone but share the CPU with crash-point child processes in the
 * default project; this bound only guards against hangs, it does not change the number of runs.
 */
export const HEAVY_PROPERTY_TIMEOUT_MS = 180_000;
