"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Clock,
  Plus,
  AlertTriangle,
  ArrowRight,
  Loader2,
  Check,
  CalendarClock,
} from "lucide-react";
import type { Availability, PitCall } from "@/lib/types";
import {
  setAvailabilityAction,
  logCommitmentAction,
  deferTaskAction,
  setProjectDeadlineAction,
} from "@/lib/actions";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/**
 * The deployable-time control: set the weekly availability template, then log
 * commitments. Logging a commitment runs the forecast and surfaces pit calls.
 */
export function TimeBudget({
  availability,
  today,
}: {
  availability: Availability[];
  today: string;
}) {
  const [hours, setHours] = useState<number[]>(() => {
    const arr = Array<number>(7).fill(0);
    for (const a of availability) arr[a.weekday] = a.hours;
    return arr;
  });
  const [savingDay, setSavingDay] = useState<number | null>(null);
  const [, startAvail] = useTransition();

  function setDay(weekday: number, val: number) {
    setHours((h) => {
      const n = [...h];
      n[weekday] = val;
      return n;
    });
  }

  function commitDay(weekday: number, val: number) {
    setSavingDay(weekday);
    startAvail(async () => {
      await setAvailabilityAction([{ weekday, hours: val }]);
      setSavingDay(null);
    });
  }

  const [date, setDate] = useState(today);
  const [cHours, setCHours] = useState("");
  const [label, setLabel] = useState("");
  const [logging, startLog] = useTransition();
  const [pitCalls, setPitCalls] = useState<PitCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function log() {
    const h = Number(cHours);
    if (!date || !Number.isFinite(h) || h <= 0) {
      setError("Pick a date and a number of hours.");
      return;
    }
    setError(null);
    startLog(async () => {
      const res = await logCommitmentAction(date, h, label || null);
      if (res.error) {
        setError(res.error);
      } else {
        setPitCalls(res.pitCalls);
        setCHours("");
        setLabel("");
      }
    });
  }

  const weeklyTotal = hours.reduce((s, h) => s + h, 0);

  return (
    <Card>
      <CardHeader title="Time budget" icon={<Clock className="size-4" />} />
      <CardBody className="space-y-5">
        {/* Weekly availability template */}
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-muted)]">
            Weekly availability — {weeklyTotal}h/week
          </p>
          <div className="grid grid-cols-7 gap-1.5">
            {DAYS.map((d, wd) => (
              <div key={wd} className="flex flex-col items-center gap-1">
                <span className="text-[11px] text-[var(--color-fg-subtle)]">
                  {d}
                </span>
                <input
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={hours[wd]}
                  onChange={(e) => setDay(wd, Number(e.target.value) || 0)}
                  onBlur={(e) => commitDay(wd, Number(e.target.value) || 0)}
                  aria-label={`${d} available hours`}
                  className={cn(
                    "h-9 w-full rounded-sm border bg-[var(--color-surface)] text-center text-[13px] font-medium text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none",
                    savingDay === wd
                      ? "border-[var(--color-accent)]"
                      : "border-[var(--color-border)]",
                  )}
                />
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--color-fg-subtle)]">
            Hours you can actually deploy each day. Set once; log interruptions
            below.
          </p>
        </div>

        {/* Commitment logger */}
        <div className="border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-muted)]">
            Log a commitment
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-fg-subtle)]">
                Date
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-fg-subtle)]">
                Hours
              </span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={cHours}
                onChange={(e) => setCHours(e.target.value)}
                placeholder="3"
                className="h-9 w-20 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <label className="flex min-w-[120px] flex-1 flex-col gap-1">
              <span className="text-[11px] text-[var(--color-fg-subtle)]">
                What (optional)
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Friends, gym…"
                className="h-9 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={log}
              disabled={logging}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {logging ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Log
            </button>
          </div>
          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</p>
          )}
        </div>

        {/* Pit calls */}
        {pitCalls &&
          (pitCalls.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-[13px] text-[var(--color-fg-muted)]">
              <Check className="size-4 shrink-0 text-[var(--color-status-done)]" />
              Logged — no project&apos;s probability dropped meaningfully.
            </div>
          ) : (
            <div className="space-y-2">
              {pitCalls.map((pc) => (
                <PitCallCard key={pc.projectId} pc={pc} />
              ))}
            </div>
          ))}
      </CardBody>
    </Card>
  );
}

function PitCallCard({ pc }: { pc: PitCall }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [appliedTasks, setAppliedTasks] = useState<Set<string>>(new Set());
  const [rescheduled, setRescheduled] = useState(false);

  function applyDefer(taskId: string) {
    setBusy(taskId);
    startTransition(async () => {
      await deferTaskAction(taskId, true);
      setAppliedTasks((s) => new Set(s).add(taskId));
      setBusy(null);
    });
  }

  function applyReschedule(deadline: string) {
    setBusy("reschedule");
    startTransition(async () => {
      await setProjectDeadlineAction(pc.projectId, deadline);
      setRescheduled(true);
      setBusy(null);
    });
  }

  const moves = pc.moves.filter((m) => !appliedTasks.has(m.taskId));

  return (
    <div className="rounded-md border border-[var(--color-border)] border-l-2 border-l-[var(--color-danger)] bg-[var(--color-surface-raised)] p-3.5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[var(--color-fg)]">
            <Link
              href={`/projects/${pc.projectId}`}
              className="hover:underline"
            >
              {pc.projectName}
            </Link>{" "}
            dropped{" "}
            <span className="tabular-nums text-[var(--color-fg-muted)]">
              {formatPct(pc.probabilityBefore)}
            </span>
            {" → "}
            <span
              className={cn("font-semibold tabular-nums", toneText(pc.probabilityAfter))}
            >
              {formatPct(pc.probabilityAfter)}
            </span>
          </p>

          {moves.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Recover by
              </p>
              {moves.map((m) => (
                <div
                  key={m.taskId}
                  className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)]"
                >
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    Defer “{m.title}”
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-[var(--color-status-done)]">
                    → {formatPct(m.probabilityAfter)}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === m.taskId}
                    disabled={pending}
                    onClick={() => applyDefer(m.taskId)}
                  >
                    Defer
                  </Button>
                </div>
              ))}
            </div>
          )}

          {pc.reschedule && !rescheduled && (
            <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)]">
              <CalendarClock className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {moves.length > 0 ? "Or move deadline to " : "Move deadline to "}
                {formatDate(pc.reschedule.deadline)}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-[var(--color-status-done)]">
                → {formatPct(pc.reschedule.probabilityAfter)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "reschedule"}
                disabled={pending}
                onClick={() => applyReschedule(pc.reschedule!.deadline)}
              >
                Move
              </Button>
            </div>
          )}

          {rescheduled && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
              <Check className="size-3.5" /> Deadline moved.
            </p>
          )}

          {moves.length === 0 && !pc.reschedule && !rescheduled && (
            <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
              No single deferral recovers it — consider adding hours or splitting
              the work.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
