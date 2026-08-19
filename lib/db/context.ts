import { AsyncLocalStorage } from "async_hooks";

// Ambient "who is this request for?", so the same data layer works in two runtimes with nothing
// in common. Inside Next the answer comes from the session cookie; inside an SQS worker there's
// no cookie and no request, only a job payload with a user id. All ~200 call sites in store.ts
// reach for getRequestClient() with no argument, so the alternative is threading a uid through
// every one of them.
//
// AsyncLocalStorage rather than a module-scope variable precisely because a Lambda execution
// environment is REUSED across invocations. A plain `let currentUid` would survive from one job
// to the next, and the failure mode is the worst one available here: job B running with job A's
// user id, writing one account's data into another's. ALS scopes the value to the async call
// tree, so it can't outlive the job.

const storage = new AsyncLocalStorage<string>();

export function runAsUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(uid, fn);
}

export function ambientUserId(): string | null {
  return storage.getStore() ?? null;
}
