import { ALL_WINDOWS, type TimeWindow } from "./velocity";

// Explicit per-window availability (OVERHAUL §5a S3b Phase 4, design Pillar 1 / decision #5).
//
// By default the windowed forecast DERIVES how a day's hours split across the five
// time-of-day windows from observed `work_sessions` (a shrunk session share). This lets a
// user instead PIN that split - "I work mornings and evenings, never afternoons" - when the
// inferred share is wrong or sparse. It is an OPTIONAL override, never a prerequisite: the
// objective ships on the derived model, and pinning the share only bounds how much work can
// claim each window's *learned velocity* - it authors no probability. With no velocity
// learned the profile is still null (a share without a multiplier is byte-identical-neutral),
// so a pin has no effect until the window velocity is earned. Pure / client-safe.

export const WINDOW_AVAILABILITY_VERSION = 1;

/** Per-user explicit window availability: a relative WEIGHT per window (≥ 0). All-zero ⇒
 *  unset (fall back to the derived share). The weights are normalised to a share when
 *  applied, so only their RATIO matters - "morning 2, evening 1" = morning gets twice the
 *  capacity of evening, afternoon none. */
export interface WindowAvailability {
  version: number;
  weights: Record<TimeWindow, number>;
}

/** Largest weight a single window may carry (a guard against pathological input; the ratio
 *  is what matters, so the cap is generous). */
const MAX_WINDOW_WEIGHT = 100;

function zeroWeights(): Record<TimeWindow, number> {
  const w = {} as Record<TimeWindow, number>;
  for (const win of ALL_WINDOWS) w[win] = 0;
  return w;
}

/** The unset default - all weights 0 ⇒ use the derived share. */
export const EMPTY_WINDOW_AVAILABILITY: WindowAvailability = {
  version: WINDOW_AVAILABILITY_VERSION,
  weights: zeroWeights(),
};

/** Coerce arbitrary stored/posted JSON into a valid `WindowAvailability`: every window
 *  present, each weight a finite number clamped to `[0, MAX_WINDOW_WEIGHT]` (non-numbers ⇒ 0).
 *  Idempotent. */
export function normalizeWindowAvailability(raw: unknown): WindowAvailability {
  const src =
    raw && typeof raw === "object" && "weights" in raw
      ? (raw as { weights?: unknown }).weights
      : raw;
  const weights = zeroWeights();
  if (src && typeof src === "object") {
    const obj = src as Record<string, unknown>;
    for (const win of ALL_WINDOWS) {
      const v = obj[win];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        weights[win] = Math.min(MAX_WINDOW_WEIGHT, v);
      }
    }
  }
  return { version: WINDOW_AVAILABILITY_VERSION, weights };
}

/** The explicit share override for the windowed forecast, or null when unset (all weights
 *  ≤ 0 ⇒ fall back to the derived share). Normalises the weights to sum 1 - the same shape
 *  `observedWindowShare` returns - so `windowProfileFromEnergy` can drop it straight in. Pure. */
export function windowShareOverride(
  avail: WindowAvailability | null | undefined,
): Record<TimeWindow, number> | null {
  if (!avail) return null;
  let total = 0;
  for (const win of ALL_WINDOWS) total += Math.max(0, avail.weights[win] ?? 0);
  if (total <= 0) return null;
  const share = {} as Record<TimeWindow, number>;
  for (const win of ALL_WINDOWS) share[win] = Math.max(0, avail.weights[win] ?? 0) / total;
  return share;
}
