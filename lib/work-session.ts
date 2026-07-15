// Client-side capture of the user's LOCAL clock for a work-session write (OVERHAUL
// S2 slice B). The completion / effort-log server actions run server-side, where
// `new Date()` is the SERVER's clock - so the browser must stamp the LOCAL window /
// weekday / day at the moment it fires the action and pass it in. This is the
// timezone-gotcha resolution (design decision 7): we never re-derive a local window
// from the UTC `completed_at` instant. Imports only pure modules - safe to call
// from a "use client" component.

import type { WorkSessionLocal } from "./types";
import { windowOf } from "./velocity";

/** Two-digit zero-pad for the local ISO date parts. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Stamp the caller's LOCAL window / weekday / day right now. Call it in a client
 * component as it invokes a completion action - `getHours` / `getDay` /
 * `getFullYear…` are all local, so the session is recorded in the user's own
 * timezone regardless of where the server runs. `now` is injectable for tests.
 */
export function localSessionStamp(now: Date = new Date()): WorkSessionLocal {
  return {
    time_window: windowOf(now.getHours()),
    weekday: now.getDay(),
    logged_for: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}
