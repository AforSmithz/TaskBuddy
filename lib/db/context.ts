import { AsyncLocalStorage } from "async_hooks";

// Ambient "who is this request for?", so the same data layer works in two
// runtimes that have nothing in common.
//
// Inside Next, the answer comes from the session cookie. Inside an SQS worker
// there is no cookie and no request - only a job payload with a user id in it.
// Every one of the ~200 call sites in lib/store.ts reaches for
// `getRequestClient()` with no argument, so the alternative to this module is
// threading a uid through all of them.
//
// AsyncLocalStorage is the right primitive rather than a module-scope variable
// precisely because a Lambda execution environment is REUSED across
// invocations. A plain `let currentUid` would survive from one job to the next,
// and the failure mode is the worst one available in this codebase: job B runs
// with job A's user id and writes one account's data into another's. ALS scopes
// the value to the async call tree instead, so it cannot outlive the job.

const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `uid` as the ambient user. Used by the workers; Next uses the
 * cookie path instead and never calls this.
 */
export function runAsUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(uid, fn);
}

/** The ambient user id, or null when there is no enclosing `runAsUser`. */
export function ambientUserId(): string | null {
  return storage.getStore() ?? null;
}
