import type { ForecastResult } from "@/lib/types";
import { isOnTrack, ON_TRACK_PROBABILITY } from "@/lib/types";

// Critical-chain buffering - a forecast()-honesty read, no new data.
//
// forecast() already Monte-Carlos the whole distribution of remaining work. The gap between its
// safe outcome (p90) and its median plan (p50) is the safety margin the estimate variance
// demands - the project buffer - and the deadline's deployable time says how much of it is still
// intact. Everything here is a pure READING of the forecast(): it never authors a probability.

/** The odds at or above which the buffer is comfortable. The "on-track but thin" band is
 *  [ON_TRACK, COMFORTABLE), which maps exactly to deployable in [p80, p90). The trigger is the
 *  odds band, not a consumed-fraction threshold: on a p50-p90 basis the buffer is barely touched
 *  while on track, so a consumed gate would be unreachable dead code. */
export const BUFFER_COMFORTABLE_PROBABILITY = 0.9;

export interface BufferStatus {
  /** p90 − p50: the variance-demanded safety margin, minutes (display). */
  bufferMinutes: number;
  /** max(0, deployable − p50): clear slack above the median plan, minutes. */
  remainingMinutes: number;
  /** 0 - 1 share of the p50 - p90 margin the deadline leaves uncovered (display). */
  consumedFraction: number;
  /** Tone, driven by the odds (the monotone quantity that can't disagree with the headline)
   *  rather than the consumed fraction. `thin` is where the advisory fires; `breached` is where
   *  the critical at_risk/over_budget reasons take over. */
  tone: "secure" | "thin" | "breached";
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The critical-chain buffer for one forecast, or null when none is defined: no deadline, no
 *  open work, or a degenerate distribution (p90 <= p50). A null buffer surfaces nothing. */
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

/** The advisory early warning: the goal clears the on-track line but not the comfortable one, so
 *  its buffer is partially committed and one overrun could flip it. `thin` implies on-track, so
 *  it never double-lists with the critical deadline reasons. */
export function isBufferLow(fc: ForecastResult): boolean {
  return criticalChainBuffer(fc)?.tone === "thin";
}

/** How thin the buffer is, as a graded urgency in [0,1]: 0 when not thin, rising to 1 as a thin
 *  project's odds approach the on-track line. Linear across the thin band, so a project just
 *  below comfortable is barely urgent and one about to fall off is fully urgent. The arrangement's
 *  buffer lever scales by this, so the THINNEST deadline gets the strongest claim on the day's
 *  fast windows. Pure, so the server decides it once on the base and the client replays it. */
export function bufferUrgency(fc: ForecastResult): number {
  if (criticalChainBuffer(fc)?.tone !== "thin") return 0;
  const span = BUFFER_COMFORTABLE_PROBABILITY - ON_TRACK_PROBABILITY;
  if (span <= 0) return 1;
  return clamp01((BUFFER_COMFORTABLE_PROBABILITY - fc.probability) / span);
}
