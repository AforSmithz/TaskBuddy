"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, GraduationCap, Sparkles, Timer, Undo2 } from "lucide-react";
import {
  resolveSubsetCumulative,
  type ResolveInput,
} from "@/lib/portfolio-state";
import type { DependencyEdge } from "@/lib/schedule";
import {
  commitStrategyBundleAction,
  logActualTimeAction,
  quickAddErrandAction,
  undoPlanVersionAction,
  type CheckinRunResult,
} from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import type { CheckinProposal, StrategyMove } from "@/lib/types";
import { cn } from "@/lib/cn";

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/** A short label for the odds-silent Family-B rows — never a percentage (a 0% next
 *  to a log would mislead; the design keeps these visually distinct). */
function actionLabel(p: CheckinProposal): { icon: typeof Timer; text: string } {
  const a = p.action;
  if (a?.kind === "log_progress") return { icon: Timer, text: `Log ${a.minutes} min` };
  if (a?.kind === "capture_idea") return { icon: Sparkles, text: "Capture" };
  return { icon: Check, text: "Note" };
}

/** Optional context for `moveOutcome` — the shipped task titles + DAG so a
 *  resolve_blocker line can name its freed dependents (§5.6 6b). Display-only. */
interface OutcomeCtx {
  titleById: Map<string, string>;
  deps: DependencyEdge[];
}

/** One line of the post-commit outcome summary (§5.6 slice 6a/6b) — a glyph + the item
 *  title (+ optional sub-lines), derived purely from the committed move's payload and
 *  the shipped re-solve inputs (no probability is computed here — frontend rule §2.8).
 *  The glyph carries the meaning: ✓ done/learned/cleared, ＋ added scope, → moved, − skipped. */
function moveOutcome(
  move: StrategyMove,
  ctx?: OutcomeCtx,
): { glyph: string; text: string; done: boolean; sub?: string[] } {
  const p = move.payload;
  switch (p.kind) {
    case "mark_done":
      return { glyph: "✓", text: p.title, done: true };
    case "attain_skill":
      return { glyph: "✓", text: `learned ${p.title}`, done: true };
    case "resolve_blocker": {
      // Cleared a blocker: list the freed dependents by title, and honestly flag any
      // that still wait on OTHER work (partial satisfaction — decision #3). Both reads
      // are display-only filters over the shipped DAG + titles, never a re-derivation.
      const titleById = ctx?.titleById;
      const deps = ctx?.deps ?? [];
      const sub = p.freedTaskIds.map((id) => {
        const title = titleById?.get(id) ?? "a task";
        const stillGated = deps.some(
          (d) =>
            d.task_id === id &&
            d.depends_on_task_id !== p.blockerTaskId &&
            (titleById?.has(d.depends_on_task_id) ?? false),
        );
        return stillGated ? `${title} — still waiting on other work` : `freed ${title}`;
      });
      return {
        glyph: "✓",
        text: `cleared ${p.title}${p.resolvedBy ? ` · via ${p.resolvedBy}` : ""}`,
        done: true,
        sub: sub.length > 0 ? sub : undefined,
      };
    }
    case "add_tasks":
      return { glyph: "＋", text: p.tasks[0]?.title ?? "new task", done: false };
    case "reschedule_task":
    case "defer":
      return { glyph: "→", text: "title" in p ? p.title : move.rationale, done: false };
    case "skip_activity":
      return { glyph: "−", text: p.title, done: false };
    default:
      return { glyph: "·", text: move.rationale, done: false };
  }
}

/**
 * The inline review surface for an interpreted check-in (§5.6 slice 5). Reuses the
 * S1 live-re-solve (`resolveSubsetCumulative`) for the odds-moving Family-A rows and
 * the S1 commit/undo (`commitStrategyBundleAction` / `undoPlanVersionAction`); the
 * odds-silent Family-B rows confirm captures/logs with no percentage. The whole
 * accepted Family-A set commits as ONE PlanVersion so Undo reverts it atomically.
 */
export function CheckinReview({
  result,
  onDone,
}: {
  result: CheckinRunResult;
  onDone: () => void;
}) {
  const { review, resolveInput } = result;
  const { proposals, chips } = review;

  // Included rows (by proposal index) — seeded from each proposal's defaultChecked
  // (high-confidence + resolved → on; ambiguous / inferred spillover → off).
  const [included, setIncluded] = useState<Set<number>>(
    () => new Set(proposals.flatMap((p, i) => (p.defaultChecked ? [i] : []))),
  );
  const [committed, setCommitted] = useState(false);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Live re-solve over the SELECTED Family-A moves (in row order), mirroring the
  // strategy card: each row shows the portfolio odds after it + everything before.
  const live = useMemo(() => {
    const seq = proposals
      .map((p, index) => ({ p, index }))
      .filter(({ p, index }) => p.family === "A" && p.move && included.has(index));
    const { afterEach, combined } = resolveSubsetCumulative(
      resolveInput as ResolveInput,
      seq.map((x) => x.p.move!),
    );
    const byIndex = new Map<number, number>();
    seq.forEach((x, i) => byIndex.set(x.index, afterEach[i]));
    return { byIndex, combined };
  }, [proposals, included, resolveInput]);

  // Base portfolio odds (no moves) — the "before" of the post-commit odds transition.
  // Same sanctioned S1 client re-solve as `live`; never a hand-rolled probability.
  const baseCombined = useMemo(
    () => resolveSubsetCumulative(resolveInput as ResolveInput, []).combined,
    [resolveInput],
  );

  function toggle(index: number) {
    setIncluded((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const selected = proposals
    .map((p, index) => ({ p, index }))
    .filter(({ index }) => included.has(index));
  const familyA = selected.filter(({ p }) => p.family === "A" && p.move);
  const familyB = selected.filter(({ p }) => p.family === "B" && p.action);
  const total = selected.length;

  function apply() {
    if (total === 0 || pending) return;
    const movesA = familyA.map(({ p }) => p.move!);
    startTransition(async () => {
      let newVersionId: string | null = null;
      if (movesA.length > 0) {
        const before = resolveSubsetCumulative(resolveInput, []).combined;
        const after = resolveSubsetCumulative(resolveInput, movesA).combined;
        const version = await commitStrategyBundleAction(
          movesA,
          before,
          after,
          `Check-in: ${movesA.length} update${movesA.length === 1 ? "" : "s"}`,
        );
        newVersionId = version.id;
      }
      // Family-B actions are odds-silent + idempotent — run individually (log SETs
      // time, capture adds an errand); they ride outside the undoable bundle.
      for (const { p } of familyB) {
        const a = p.action!;
        if (a.kind === "log_progress") await logActualTimeAction(a.taskId, a.minutes);
        else if (a.kind === "capture_idea") await quickAddErrandAction(a.text, null);
      }
      setVersionId(newVersionId);
      setCommitted(true);
    });
  }

  function undo() {
    if (!versionId || pending) return;
    startTransition(async () => {
      await undoPlanVersionAction(versionId);
      setVersionId(null);
      setCommitted(false);
    });
  }

  if (committed) {
    // Post-commit outcome summary (§5.6 slice 6a): what the accepted moves did,
    // grouped by goal (recital ✓ / work ✓ / gym −), the portfolio odds transition,
    // and a reflective end-of-day read. All from already-committed data + the same
    // sanctioned S1 re-solve — no fresh probability is computed here.
    // Titles + DAG for naming a resolve_blocker's freed dependents (§5.6 6b) — the same
    // shipped re-solve inputs the odds use; no fresh computation, display only.
    const outcomeCtx: OutcomeCtx = {
      titleById: new Map(resolveInput.tasks.map((t) => [t.id, t.title])),
      deps: resolveInput.deps,
    };
    const groups = new Map<string, ReturnType<typeof moveOutcome>[]>();
    for (const { p } of familyA) {
      const key = p.move!.projectName || "Portfolio";
      const arr = groups.get(key) ?? [];
      arr.push(moveOutcome(p.move!, outcomeCtx));
      groups.set(key, arr);
    }
    const hadOdds = familyA.length > 0;
    const eod = result.eod;
    const eodBits = [
      `${eod.completed.length} done`,
      eod.in_review.length > 0 ? `${eod.in_review.length} in review` : null,
    ].filter((x): x is string => x !== null);

    return (
      <div className="rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
            <Check className="size-4 text-[var(--color-status-done)]" aria-hidden />
            Logged {total} update{total === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-3">
            {versionId && (
              <button
                type="button"
                onClick={undo}
                disabled={pending}
                className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] disabled:opacity-50"
              >
                <Undo2 className="size-3.5" aria-hidden />
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={onDone}
              className="text-[13px] font-medium text-[var(--color-accent-fg)] hover:underline"
            >
              Done
            </button>
          </span>
        </div>

        {hadOdds && (
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
            <span className="text-[12px] text-[var(--color-fg-muted)]">
              Portfolio odds of all deadlines landing
            </span>
            <span className="flex items-center gap-1.5 text-[13px] font-semibold tabular-nums">
              <span className="text-[var(--color-fg-subtle)]">{formatPct(baseCombined)}</span>
              <span className="text-[var(--color-fg-subtle)]">→</span>
              <span className={toneText(live.combined)}>{formatPct(live.combined)}</span>
            </span>
          </div>
        )}

        {groups.size > 0 && (
          <ul className="divide-y divide-[var(--color-border)]">
            {[...groups.entries()].map(([name, items]) => (
              <li key={name} className="px-4 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  {name}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {items.map((it, i) => (
                    <li key={i} className="text-[13px] text-[var(--color-fg)]">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "shrink-0 tabular-nums",
                            it.done ? "text-[var(--color-status-done)]" : "text-[var(--color-fg-subtle)]",
                          )}
                          aria-hidden
                        >
                          {it.glyph}
                        </span>
                        <span className="min-w-0 truncate">{it.text}</span>
                      </span>
                      {it.sub && it.sub.length > 0 && (
                        <ul className="ml-6 mt-0.5 space-y-0.5">
                          {it.sub.map((s, j) => (
                            <li
                              key={j}
                              className="truncate text-[12px] text-[var(--color-fg-subtle)]"
                            >
                              ↳ {s}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {familyB.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--color-border)] px-4 py-2.5 text-[12px] text-[var(--color-fg-muted)]">
            {familyB.map(({ p }, i) => {
              const a = p.action!;
              const Icon = a.kind === "log_progress" ? Timer : Sparkles;
              return (
                <span key={i} className="flex items-center gap-1">
                  <Icon className="size-3" aria-hidden />
                  {a.kind === "log_progress"
                    ? `${a.minutes}m on ${a.title}`
                    : a.kind === "capture_idea"
                      ? `captured “${a.text}”`
                      : "noted"}
                </span>
              );
            })}
          </div>
        )}

        <div className="border-t border-[var(--color-border)] px-4 py-2.5 text-[12px] text-[var(--color-fg-subtle)]">
          Today so far: {eodBits.join(" · ")}
          {eod.tomorrow_focus[0] && (
            <>
              {" · up next: "}
              <span className="text-[var(--color-fg-muted)]">{eod.tomorrow_focus[0]}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  const hasAnything = proposals.length > 0 || chips.length > 0;

  return (
    <div className="rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <span className="text-[13px] font-semibold text-[var(--color-fg)]">
          {hasAnything ? "Here's what I caught" : "Nothing to act on"}
        </span>
        <span className="text-[11px] text-[var(--color-fg-subtle)]">
          {result.source === "llm" ? "Interpreted" : "Quick read"}
        </span>
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {proposals.map((p, index) => {
          const checked = included.has(index);
          const isA = p.family === "A" && !!p.move;
          const odds = isA ? live.byIndex.get(index) : undefined;
          const label = !isA ? actionLabel(p) : null;
          const ambiguous = p.resolved.status === "ambiguous";
          return (
            <li key={index} className="flex items-start gap-3 px-4 py-3">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(index)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                aria-label={`Include: ${p.move?.rationale ?? label?.text ?? "update"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-[var(--color-fg)]">
                  {p.move?.rationale ??
                    (p.action?.kind === "capture_idea"
                      ? `Capture "${p.action.text}"`
                      : p.action?.kind === "log_progress"
                        ? `Log ${p.action.minutes} min on "${p.action.title}"`
                        : "Noted")}
                </span>
                <span className="mt-0.5 block truncate text-[12px] italic text-[var(--color-fg-subtle)]">
                  &ldquo;{p.resolved.intent.quote}&rdquo;
                </span>
                {ambiguous && (
                  <span className="mt-1 block text-[11px] text-[var(--color-accent-fg)]">
                    Ambiguous — {p.resolved.candidates.map((c) => c.title).join(" or ")}
                  </span>
                )}
              </span>
              {isA && odds !== undefined ? (
                <span className={cn("shrink-0 text-[13px] font-semibold tabular-nums", checked ? toneText(odds) : "text-[var(--color-fg-subtle)]")}>
                  → {formatPct(odds)}
                </span>
              ) : label ? (
                <span className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-fg-subtle)]">
                  <label.icon className="size-3.5" aria-hidden />
                  {label.text}
                </span>
              ) : null}
            </li>
          );
        })}

        {chips.length > 0 && (
          <li className="flex flex-wrap gap-2 px-4 py-3">
            {chips.map((c, i) => (
              <span
                key={i}
                className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-fg-subtle)]"
                title={c.status === "unresolved" ? "Couldn't match this to anything open" : "Acknowledged"}
              >
                {c.status === "unresolved" ? "Couldn't match: " : ""}
                &ldquo;{c.intent.quote}&rdquo;
              </span>
            ))}
          </li>
        )}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3">
        <button
          type="button"
          onClick={onDone}
          className="text-[13px] font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={total === 0 || pending}
          className="flex items-center gap-1.5 rounded-[10px] bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--color-bg)] disabled:opacity-40"
        >
          <GraduationCap className="size-4" aria-hidden />
          {pending ? "Applying…" : total === 0 ? "Nothing selected" : `Apply ${total} update${total === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
