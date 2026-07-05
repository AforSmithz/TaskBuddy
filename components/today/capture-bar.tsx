"use client";

import { useState, useTransition } from "react";
import { runCheckinAction, type CheckinRunResult } from "@/lib/actions";
import type { CheckinScope } from "@/lib/types";
import { CheckinReview } from "./checkin-review";

/**
 * The full-width universal capture bar (§5.6). Type a free-form check-in — what you
 * did, what changed, an idea, a vent — and Enter runs the interpret → resolve →
 * propose loop, then shows an inline review whose accepted moves commit as one
 * reversible PlanVersion (reusing the S1 review/commit/undo machinery). The state
 * machine: idle → interpreting → reviewing → (committed, inside the review). The
 * soft gradient orb + ↵ affordance match Direction F.
 *
 * With a `scope` (§5.6 slice 6a — the bar on a project page), the check-in binds to
 * that goal: its entities resolve first and an "I also need to…" clause becomes a
 * real task ON the goal (a live-re-solved `add_tasks` move) rather than a loose
 * capture. The global (unscoped) Today bar is unchanged.
 */
export function CaptureBar({ scope }: { scope?: CheckinScope }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<CheckinRunResult | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text || pending) return;
    startTransition(async () => {
      const res = await runCheckinAction(text, scope);
      setResult(res);
    });
  }

  function reset() {
    setResult(null);
    setValue("");
  }

  // Reviewing — the interpreted proposals replace the input until the user is done.
  if (result) {
    return <CheckinReview result={result} onDone={reset} />;
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-3.5 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 shadow-[var(--shadow-md)]"
    >
      <span
        className={`size-[30px] shrink-0 rounded-full bg-[image:var(--gradient-brand)] ${pending ? "animate-pulse" : ""}`}
        aria-hidden
      />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        placeholder={
          pending
            ? "Reading your check-in…"
            : scope
              ? `Log an update on ${scope.goalName} — done, pushed, a new task…`
              : "Type anything — what you did, an update, an idea…"
        }
        aria-label={scope ? `Check in on ${scope.goalName}` : "Capture anything"}
        className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
      />
      <span className="rounded-[7px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-subtle)]">
        ↵
      </span>
    </form>
  );
}
