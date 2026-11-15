/**
 * The arithmetic of the capacity sheet (CAPACITY.md; 09 §8; EXP-007 criterion 5): workers are
 * planned from one core and up to 1.5 GiB of memory for each running job. Those two figures are
 * the sandbox's own limits (`LIMITS` in sandbox.ts), so the plan and what a job may use cannot
 * drift apart. Nothing here is a measurement.
 */
import { LIMITS } from './sandbox.ts';

/** What the plan sets aside for one running job: the cgroup limits of its sandbox. */
export const PER_RUNNING_JOB = {
  cores: LIMITS.cpus,
  memoryGiB: LIMITS.memoryMiB / 1024,
} as const;

export interface WorkerNode {
  /** Cores of the node. */
  cores: number;
  /** Memory of the node in GiB. */
  memoryGiB: number;
  /** Cores kept for the worker process, Podman and the system. Default 0. */
  reservedCores?: number;
  /** Memory in GiB kept for the worker process, Podman and the system. Default 0. */
  reservedMemoryGiB?: number;
}

/** How many jobs may run at once on a node: whichever of cores and memory runs out first. */
export function jobsPerNode(node: WorkerNode): number {
  const cores = node.cores - (node.reservedCores ?? 0);
  const memory = node.memoryGiB - (node.reservedMemoryGiB ?? 0);
  for (const [name, value] of Object.entries({ cores, memory }))
    if (!Number.isFinite(value)) throw new RangeError(`capacity: ${name} is not a number`);
  const fit = Math.min(cores / PER_RUNNING_JOB.cores, memory / PER_RUNNING_JOB.memoryGiB);
  return Math.max(0, Math.floor(fit));
}

/** How many such nodes a number of jobs running at once needs. */
export function nodesFor(runningJobs: number, node: WorkerNode): number {
  if (!Number.isInteger(runningJobs) || runningJobs < 0)
    throw new RangeError('capacity: runningJobs is a whole number, zero or more');
  if (runningJobs === 0) return 0;
  const each = jobsPerNode(node);
  if (each === 0) throw new RangeError('capacity: the node cannot run one job');
  return Math.ceil(runningJobs / each);
}
