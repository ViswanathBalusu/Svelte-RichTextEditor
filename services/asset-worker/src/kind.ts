/**
 * The kind of the asset worker's jobs in the queue: what the control plane enqueues on
 * `POST /assets/{aid}/complete` and what the worker claims.
 *
 * It has a module of its own, offered as `@docedit/asset-worker/kind`, so that a handler of the
 * control API can queue a job without loading the worker, its S3 client or its sandbox (BE-002
 * criterion 1: handlers import no concrete driver).
 */
export const ASSET_JOB_KIND = 'asset';
