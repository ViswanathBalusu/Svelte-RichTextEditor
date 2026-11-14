/**
 * A worker thread that runs the authority's pure functions on structured-cloned plain data
 * (SYN-001 criterion 5). It receives the input as `workerData` and posts the output back.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { type AuthorityRunInput, runAuthority } from './authority-run.ts';

parentPort!.postMessage(runAuthority(workerData as AuthorityRunInput));
