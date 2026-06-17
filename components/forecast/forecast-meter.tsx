import Link from "next/link";
import type { EstimationModel, ForecastResult } from "@/lib/types";
import { MIN_ESTIMATION_SAMPLES, isOnTrack } from "@/lib/types";
import { formatDate, formatMinutes } from "@/lib/format";
import { cn } from "@/lib/cn";

// Presentational forecast UI. Pure (no "use client"), so both server and
// client components can render it.

export type Band = "track" | "risk" | "off";

/** Map a probability to its on-track band. */
export function band(probability: number): Band {
  if (isOnTrack(probability)) return "track";
  if (probability >= 0.4) return "risk";
  return "off";
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

const BAND_LABEL: Record<Band, string> = {
  track: "On track",
  risk: "At risk",
  off: "Off track",
};

const BAND_TEXT: Record<Band, string> = {
  track: "text-[var(--color-status-done)]",
  risk: "text-[var(--color-accent-fg)]",
  off: "text-[var(--color-danger)]",
};

const BAND_BAR: Record<Band, string> = {
  track: "bg-[var(--color-status-done)]",
  risk: "bg-[var(--color-accent)]",
  off: "bg-[var(--color-danger)]",
};

/** Headline forecast for a project: probability, band, slack, deadline. */
export function ForecastMeter({
  forecast,
  deadline,
}: {
  forecast: ForecastResult;
  deadline: string | null;
}) {
  const b = band(forecast.probability);
  const slack = forecast.slackMinutes;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
            On-time probability
          </p>
          <p
            className={cn(
              "mt-1 text-[32px] font-bold leading-none tabular-nums",
              BAND_TEXT[b],
            )}
          >
            {formatPct(forecast.probability)}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] font-semibold",
            BAND_TEXT[b],
          )}
        >
          <span className={cn("size-1.5 rounded-full", BAND_BAR[b])} />
          {BAND_LABEL[b]}
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-overlay)]">
        <div
          className={cn("h-full rounded-full transition-all duration-500", BAND_BAR[b])}
          style={{ width: `${Math.round(forecast.probability * 100)}%` }}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-fg-muted)]">
        <span>Deadline {formatDate(deadline)}</span>
        <span>
          {forecast.openTaskCount} open · {formatMinutes(forecast.expectedMinutes)} est
        </span>
        {forecast.openTaskCount > 0 && forecast.p90Minutes > forecast.p10Minutes && (
          <span>
            {formatMinutes(forecast.p10Minutes)}–{formatMinutes(forecast.p90Minutes)} likely
          </span>
        )}
        <span className={slack < 0 ? "text-[var(--color-danger)]" : undefined}>
          {slack >= 0
            ? `${formatMinutes(slack)} slack`
            : `${formatMinutes(-slack)} over budget`}
        </span>
      </div>
    </div>
  );
}

/**
 * One-line note explaining that the forecast is tilted by the user's own
 * estimation history. Renders nothing until there's enough history to trust
 * (below `MIN_ESTIMATION_SAMPLES` the forecast runs on the unbiased default).
 */
export function ForecastCalibration({ model }: { model: EstimationModel }) {
  if (model.sampleSize < MIN_ESTIMATION_SAMPLES) return null;

  // Median factor = exp(meanLog): how a typical estimate maps to reality.
  const skew = Math.round((Math.exp(model.meanLog) - 1) * 100);
  const phrase =
    Math.abs(skew) < 1
      ? "your estimates are spot-on"
      : skew > 0
        ? `you run ~${skew}% over`
        : `you finish ~${Math.abs(skew)}% under`;

  return (
    <p className="text-[12px] text-[var(--color-fg-subtle)]">
      Calibrated to your history ({model.sampleSize} tasks): {phrase}.
    </p>
  );
}

/** Compact on-track chip for lists (Today page). Links to the project. */
export function ProbabilityPill({
  projectId,
  name,
  probability,
}: {
  projectId: string;
  name: string;
  probability: number;
}) {
  const b = band(probability);
  return (
    <Link
      href={`/projects/${projectId}`}
      className="flex items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 transition-colors hover:border-[var(--color-border-strong)]"
    >
      <span className={cn("size-2 shrink-0 rounded-full", BAND_BAR[b])} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-fg)]">
        {name}
      </span>
      <span
        className={cn(
          "shrink-0 text-[13px] font-semibold tabular-nums",
          BAND_TEXT[b],
        )}
      >
        {formatPct(probability)}
      </span>
    </Link>
  );
}
