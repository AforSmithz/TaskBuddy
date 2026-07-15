import type { ForecastResult } from "./types";
import { isOnTrack, ON_TRACK_PROBABILITY } from "./types";

// Critical-chain buffering (§4 / OVERHAUL §5a substrate S3a) - a forecast-honesty
// read, no new data.
//
// `forecast()` already Monte-Carlos the whole distribution of remaining work. The
// gap between its safe outcome (`p90`) and its committed/median plan (`p50`) is the
// safety margin the estimate variance demands - the project buffer. The deadline's
// deployable time tells us how much of that margin is still intact. Everything here
// is a pure *reading* of the forecast: `forecast()` stays the sole owner of the odds
// (§0), so this never authors a probability - it only describes one.

/**
 * The odds at/above which the buffer is comfortable. The "on-track but thin" band
 * is `[ON_TRACK_PROBABILITY, BUFFER_COMFORTABLE_PROBABILITY)` - which maps exactly to
 * `deployable ∈ [p80, p90)`. The trigger is the odds band, NOT a consumed-fraction
 * threshold: on the p50 - p90 basis the buffer is barely touched while on-track (`p80`
 * sits close to `p90`), so a consumed gate would be unreachable dead code.
 */
export const BUFFER_COMFORTABLE_PROBABILITY = 0.9;

export interface BufferStatus {
  /** p90 − p50: the variance-demanded safety margin, minutes (display). */
  bufferMinutes: number;
  /** max(0, deployable − p50): clear slack above the median plan, minutes. */
  remainingMinutes: number;
  /** 0 - 1 share of the p50 - p90 margin the deadline leaves uncovered (display). */
  consumedFraction: number;
  /**
   * Tone - driven by the odds (the monotone quantity that can't disagree with the
   * headline), not the consumed fraction. `secure` ≥ comfortable; `thin` on-track
   * but below comfortable (where the advisory fires); `breached` once off the
   * on-track line (where the critical `at_risk` / `over_budget` reasons take over).
   */
  tone: "secure" | "thin" | "breached";
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The critical-chain buffer for one forecast, or null when no buffer is defined:
 * no deadline (deployable 0), no open work, or a degenerate distribution
 * (`p90 ≤ p50`). A null buffer surfaces nothing and fires nothing - there is no
 * honest margin to report.
 */
export function criticalChainBuffer(fc: ForecastResult): BufferStatus | null {
  if (fc.openTaskCount <= 0) return null;
  if (fc.deployableMinutes <= 0) return null;
  const bufferMinutes = fc.p90Minutes - fc.p50Minutes;
  if (bufferMinutes <= 0) return null;

  const consumedFraction = clamp01(
    (fc.p90Minutes - fc.deployableMinutes) / bufferMinutes,
  );
  const remainingMinutes = Math.max(0, fc.deployableMinutes - fc.p50Minutes);
  const tone: BufferStatus["tone"] = !isOnTrack(fc.probability)
    ? "breached"
    : fc.probability >= BUFFER_COMFORTABLE_PROBABILITY
      ? "secure"
      : "thin";

  return { bufferMinutes, remainingMinutes, consumedFraction, tone };
}

/**
 * The advisory early-warning gate (§5a S3a slice 1b): the goal clears the on-track
 * line but not the comfortable one, so its safety buffer is partially committed and
 * a single overrun could flip it. `tone === "thin"` ⇒ inherently `isOnTrack`, so it
 * never double-lists with the critical deadline reasons. False when no buffer
 * exists.
 */
export function isBufferLow(fc: ForecastResult): boolean {
  return criticalChainBuffer(fc)?.tone === "thin";
}

/**
 * How thin the buffer is, as a graded urgency in `[0, 1]` (OVERHAUL S3b Phase 4): `0`
 * when the buffer is not thin (secure, breached, or none), rising to `1` as a thin
 * project's odds approach the on-track line. Linear in the odds across the thin band
 * `[ON_TRACK_PROBABILITY, BUFFER_COMFORTABLE_PROBABILITY)`: a project just below
 * comfortable is barely urgent (~0), one about to fall off the on-track line is fully
 * urgent (~1). The arrangement's `w_buffer` lever scales by this, so the THINNEST
 * deadline gets the strongest claim on the day's fast windows - a graded refinement of
 * the binary `isBufferLow` membership the term used before. Pure; same forecast ⇒ same
 * urgency, so the server decides it once on the base and the S1 client replays it.
 */
export function bufferUrgency(fc: ForecastResult): number {
  if (criticalChainBuffer(fc)?.tone !== "thin") return 0;
  const span = BUFFER_COMFORTABLE_PROBABILITY - ON_TRACK_PROBABILITY;
  if (span <= 0) return 1;
  return clamp01((BUFFER_COMFORTABLE_PROBABILITY - fc.probability) / span);
}
