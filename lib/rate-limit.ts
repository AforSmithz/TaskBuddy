import { headers } from "next/headers";

// A small fixed-window limiter for the two unauthenticated Server Actions.
//
// loginAction runs a real cost-12 bcrypt on EVERY request, including ones whose email doesn't
// exist - deliberate, because answering a miss in 1ms and a hit in 290ms is a free account
// enumeration oracle. The cost of that property is an unauthenticated endpoint burning ~290ms
// of CPU per hit, which is billable and competes with co-tenant requests, so a trivial script
// can hold the app degraded and the meter running. This sits IN FRONT of the bcrypt, so a
// blocked attempt costs a Map lookup instead of a third of a second of CPU.
//
// What it is not: state is per instance and in memory, so it doesn't coordinate across
// instances (an attacker spreading load gets a multiple of the limit), it resets on recycle,
// and it can't stop the request reaching the function at all - the invocation is still billed,
// just not the bcrypt inside it. The real fix for all three is the edge rate-limit rule; this
// is defence in depth underneath it, and the half worth having on its own because it protects
// the expensive operation rather than the cheap one. No Redis or KV on purpose - a second
// network dependency on the login path would cost more availability than it buys.

interface Window {
  count: number;
  /** Epoch ms when the current window opened. */
  startedAt: number;
}

const WINDOW_MS = 60_000;

/** Cap on tracked keys. Without it a spray across many source addresses turns the limiter into
 *  unbounded memory growth - a denial of service delivered through the thing meant to prevent
 *  one. */
const MAX_KEYS = 5_000;

const windows = new Map<string, Window>();

/** Drop expired entries. Called on write, so there is no timer to leak. */
function sweep(now: number): void {
  for (const [key, w] of windows) {
    if (now - w.startedAt >= WINDOW_MS) windows.delete(key);
  }
  // Still over cap after sweeping means a live spray rather than stale entries.
  // Map iterates in insertion order, so this drops the oldest first.
  if (windows.size > MAX_KEYS) {
    const excess = windows.size - MAX_KEYS;
    let dropped = 0;
    for (const key of windows.keys()) {
      windows.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/** Best-effort client address. x-vercel-forwarded-for is set by the platform and can't be
 *  spoofed; x-forwarded-for can be, so it's only a local-dev fallback. With neither present every
 *  caller collapses onto one bucket, which fails toward over-limiting - the right direction for
 *  something guarding an expensive operation. */
async function clientKey(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

/** The window accounting, with no Next runtime and no clock of its own. Split out for the same
 *  reason query.ts is split from shim.ts: it makes the part with the actual logic exercisable
 *  from a plain-Node harness. `now` is injected so a test can advance time without sleeping
 *  through a real 60-second window. Returns true when the caller is over its limit. */
export function consume(key: string, limit: number, now: number): boolean {
  const existing = windows.get(key);
  if (!existing || now - existing.startedAt >= WINDOW_MS) {
     // Insert BEFORE sweeping, not after. Sweeping first trims to exactly MAX_KEYS and then this
  // write pushes it to MAX_KEYS + 1, so the cap is never actually held. Map preserves insertion
  // order and sweep evicts oldest-first, so this entry survives its own sweep.
    windows.delete(key); // re-insert at the end so its position matches its age
    windows.set(key, { count: 1, startedAt: now });
    sweep(now);
    return false;
  }

  existing.count += 1;
  return existing.count > limit;
}

/** Test seams. Never called by application code. */
export function __resetWindows(): void {
  windows.clear();
}
export function __windowCount(): number {
  return windows.size;
}
export const __MAX_KEYS = MAX_KEYS;

/** Consume one unit against `bucket` for the calling client. True means over the limit and the
 *  work should be skipped. Call BEFORE anything expensive - the whole point is not reaching the
 *  bcrypt. */
export async function isRateLimited(
  bucket: string,
  limit: number,
): Promise<boolean> {
  return consume(`${bucket}:${await clientKey()}`, limit, Date.now());
}
