import { headers } from "next/headers";

// A small fixed-window limiter for the two unauthenticated Server Actions.
//
// WHAT THIS IS FOR, specifically. `loginAction` runs a real cost-12 bcrypt on
// EVERY request, including ones whose email does not exist — that is deliberate
// (lib/password.ts DUMMY_HASH), because answering a miss in 1 ms and a hit in
// 290 ms is a free account-enumeration oracle. The cost of keeping that
// property is that an unauthenticated endpoint burns ~290 ms of CPU per hit.
// Under Vercel's Active CPU pricing that is billable, and under Fluid Compute
// it competes with co-tenant requests on the same instance. A trivial script
// can hold the app degraded and the meter running.
//
// This limiter sits IN FRONT of the bcrypt, so a blocked attempt costs a Map
// lookup instead of a third of a second of CPU.
//
// WHAT THIS IS NOT. State is per instance and in memory:
//
//   - It does not coordinate across Fluid Compute instances. An attacker
//     spreading load across instances gets a multiple of the limit.
//   - It resets when an instance is recycled.
//   - It cannot stop the request reaching the function at all, so the
//     invocation is still billed — just not the bcrypt inside it.
//
// The real fix for all three is the Vercel Firewall rate-limit rule in
// azure/VERCEL.md, which rejects at the edge before any function runs. This is
// defence in depth underneath it, and the half worth having on its own: it is
// the part that protects the expensive operation rather than the cheap one.
// Deliberately no Redis or KV — a second network dependency on the login path
// would cost more availability than it buys.

interface Window {
  count: number;
  /** Epoch ms when the current window opened. */
  startedAt: number;
}

const WINDOW_MS = 60_000;

/**
 * Cap on tracked keys. Without it, a spray across many source addresses turns
 * the limiter itself into unbounded memory growth on a 1 vCore instance — a
 * denial of service delivered through the thing meant to prevent one.
 */
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

/**
 * Best-effort client address.
 *
 * `x-vercel-forwarded-for` is set by the platform and cannot be spoofed by the
 * client; `x-forwarded-for` can be, so it is only a local-development
 * fallback. When neither is present every caller collapses onto one bucket,
 * which fails toward over-limiting rather than under-limiting — the right
 * direction for a control that guards an expensive operation.
 */
async function clientKey(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

/**
 * The window accounting, with no Next runtime and no clock of its own.
 *
 * Split out for the same reason `lib/db/query.ts` is split from `shim.ts`: it
 * makes the part with the actual logic exercisable from a plain-Node tsx
 * harness. `now` is injected rather than read so a test can advance time
 * without sleeping through a real 60-second window.
 *
 * Returns true when the caller is over its limit.
 */
export function consume(key: string, limit: number, now: number): boolean {
  const existing = windows.get(key);
  if (!existing || now - existing.startedAt >= WINDOW_MS) {
    // Insert BEFORE sweeping, not after. Sweeping first trims to exactly
    // MAX_KEYS and then this write pushes it to MAX_KEYS + 1, so the cap is
    // never actually held. Map preserves insertion order and sweep evicts
    // oldest-first, so the entry written here is the last candidate for
    // eviction and survives its own sweep.
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

/**
 * Consume one unit against `bucket` for the calling client.
 *
 * Returns true when the caller is over its limit and the work should be
 * skipped. Call this BEFORE anything expensive — the whole point is to not
 * reach the bcrypt.
 */
export async function isRateLimited(
  bucket: string,
  limit: number,
): Promise<boolean> {
  return consume(`${bucket}:${await clientKey()}`, limit, Date.now());
}
