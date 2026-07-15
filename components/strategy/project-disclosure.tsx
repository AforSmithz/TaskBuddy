"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { RecoveryPlan } from "@/lib/types";
import { RecoveryCallout } from "@/components/forecast/recovery-callout";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import { cn } from "@/lib/cn";

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/**
 * One off-track project on the /strategy page, collapsed by default. The full
 * `RecoveryCallout` - including its three eager-on-mount LLM children - only
 * mounts when the disclosure is expanded, so opening a project is what fires its
 * heavy AI tools (never on page load). A `critical` plan accents red.
 */
export function ProjectDisclosure({ plan }: { plan: RecoveryPlan }) {
  const [open, setOpen] = useState(false);
  const critical = plan.reasons.some((r) => r.severity === "critical");

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-[var(--color-fg-subtle)] transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            critical
              ? "bg-[var(--color-danger)]"
              : "bg-[var(--color-accent)]",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--color-fg)]">
          {plan.projectName}
        </span>
        <span className="shrink-0 text-[12px] text-[var(--color-fg-muted)]">
          <span
            className={cn(
              "font-semibold tabular-nums",
              toneText(plan.currentProbability),
            )}
          >
            {formatPct(plan.currentProbability)}
          </span>{" "}
          on time
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)] p-3">
          <RecoveryCallout plan={plan} />
        </div>
      )}
    </div>
  );
}
