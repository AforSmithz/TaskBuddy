// The portfolio's forecast-domain state + the pure move-patch engine (OVERHAUL
// substrate S1). Extracted out of the server-only `store.ts` so it is genuinely
// CLIENT-SAFE — it imports no DB, no `server-only`, and no gather machinery. This
// is the single abstraction the vision's two related features ride on: live
// re-solve on the review screen (vision §8.2) and whole-strategy undo / plan
// version history (vision §1.3). See `design/s1-patch-snapshot-model.md`.
//
// Everything here is PURE: identical inputs yield an identical number across
// renders/processes (the seeded `forecast.ts` Monte Carlo guarantees it), and
// nothing mutates the base gather. The functions take a NARROW slice of the
// gather (`MovePatchContext` / `JointForecastContext`) rather than the full
// server-side `ForecastGather`, which structurally satisfies them — that is what
// lets this module stay free of the gather type (and thus of `server-only`).

import type {
  ActivityCompletion,
  Availability,
  AvailabilityOverride,
  Commitment,
  EstimationModel,
  FactorScores,
  RecurringActivity,
  StrategyMove,
} from "./types";
import { computePriority } from "./priority";
import { dayCapacities, type DayCapacity, type DependencyEdge } from "./schedule";
import { globalForecastJoint, type ForecastOptions } from "./forecast";
import { buildGlobalPlan, effectiveOrder, effortToDifficulty, type AllocTask } from "./allocate";
import { activityDrainCommitments, currentWeekOwedDates } from "./recurring";
import { arrangeOrder, windowCapacities, type WindowProfile } from "./arrange";

/** The slice of the server gather a move's pure forecast-patch reads. Only the
 *  skip-move arm touches the gather (to find the activity's owed dates); every
 *  other move is a pure transform of `AllocState`. The full `ForecastGather`
 *  structurally satisfies this. */
export interface MovePatchContext {
  activities: RecurringActivity[];
  completions: ActivityCompletion[];
  today: string;
}

/** The slice of the server gather the joint re-solve reads — a superset of
 *  `MovePatchContext` (it folds moves in, then re-runs the joint forecast). The
 *  full `ForecastGather` structurally satisfies this too, so the extraction
 *  needs no change at the call sites. */
export interface JointForecastContext extends MovePatchContext {
  deadlineByProject: Map<string, string | null>;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  realCommitments: Commitment[];
  model: EstimationModel;
  /** OVERHAUL S3b Phase 2 — the per-window velocity profile (null when unlearned).
   *  When present, the joint re-solve flows over window segments derived from THIS
   *  pass's capacities, so a move preview prices time-of-day velocity exactly as the
   *  dashboard headline does. `ForecastGather` structurally satisfies it. */
  windowProfile?: WindowProfile | null;
  /** OVERHAUL S3b Phase 3 slice 2 — the one comfort cap (hard minutes/day) the scorer
   *  decided on the base order, or null when no humaner pace was afforded. When set it
   *  meters every joint re-solve (base + move probes) so the strategy page quotes the same
   *  comfort-capped plan the dashboard headline shows; takes precedence over `windowProfile`
   *  (mirrors the forecast's in-loop precedence). The scorer threads it on an augmented
   *  context — it is a post-gather decision, not a `ForecastGather` field. */
  comfortCapMinutes?: number | null;
  /** OVERHAUL S3b Phase 3 slice 3 — when set, replay the within-day reorder the scorer
   *  decided on the base order: after building this subset's order, re-sequence it with
   *  the deterministic `arrangeOrder` (group projects + slot hard work into fast windows)
   *  before pricing. Decided once on the base (like the comfort cap), not re-gated per
   *  subset; false ⇒ the canonical order, bit-for-bit. */
  arrangeReorder?: boolean;
}

/** The forecast's per-iteration estimation-bias options, drawn from the user's
 *  calibrated model. The single place that maps a model → forecast opts, so every
 *  forecast pass (per-project, joint, recovery) calibrates identically. */
export function forecastOptions(model: EstimationModel) {
  return { sigma: model.sigma, meanLog: model.meanLog };
}

/** The recurring drain (routines/goals) as synthetic commitments, so the time
 *  budget reserves their hours. Folded into capacity wherever the forecast runs;
 *  the joint re-solve re-derives it when a skip-move removes some of the drain. */
export function drainAsCommitments(
  activities: RecurringActivity[],
  completions: ActivityCompletion[],
  today: string,
): Commitment[] {
  return activityDrainCommitments(activities, completions, today).map(
    (d): Commitment => ({
      id: `recurring-drain:${d.date}`,
      date: d.date,
      hours: d.hours,
      label: "Routines & goals",
      created_at: "",
    }),
  );
}

/**
 * The shared inputs for one global allocation pass: the alloc tasks, dependency
 * edges, and the per-day capacities under a commitment set. Built once so the
 * odds, the conflict detection, and the triage probes all reason over the same
 * contention picture.
 */
export interface AllocContext {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  budget: { availability: Availability[]; overrides: AvailabilityOverride[]; commitments: Pick<Commitment, "date" | "hours">[] };
  capacities: ReturnType<typeof dayCapacities>;
}

// --- Joint scoring of a move combination (Phase 5) --------------------------
//
// The portfolio strategy needs to know the TRUE joint odds of a *set* of moves,
// not the solo per-project odds each move carries. These helpers apply any
// ordered move combination to a scratch copy of the alloc state and re-run the
// contention-aware `globalForecastJoint` over it — so the moves interact through
// the shared hour pool / real cascade, exactly as they will once applied. Pure:
// nothing here touches the DB or the base gather.

/** The mutable surface a move transforms: the alloc tasks, dep edges, deadlines,
 *  plus synthetic skip rows a `skip_activity` move adds (which re-drain capacity). */
export interface AllocState {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  deadlineByProject: Map<string, string | null>;
  /** Skip completions injected by skip-moves — they reduce the recurring drain. */
  skipCompletions: ActivityCompletion[];
}

/** A synthetic alloc task for injected work, scored from its 1-5 factors so
 *  `buildGlobalPlan` orders it plausibly among the real tasks. */
export function syntheticAllocTask(
  id: string,
  projectId: string,
  projectName: string,
  title: string,
  estimatedMinutes: number,
  f: FactorScores,
): AllocTask {
  return {
    id,
    title,
    projectId,
    projectName,
    estimatedMinutes,
    status: "todo",
    priorityScore: computePriority(f).score,
    urgency: f.urgency,
    impact: f.impact,
    risk: f.risk,
    // S3b: cognitive-load weight, so injected work is metered by the comfort cap too.
    difficulty: effortToDifficulty(f.effort),
  };
}

/**
 * Pure transform of the scratch alloc state for ONE move. Returns a NEW
 * `AllocState` (never mutates the base ctx/gather), so prefixes can be scored
 * independently. Each move maps to the same alloc-level effect its real apply
 * action has on the forecast:
 *  - defer / mark_done  → drop the task (the budget it occupied is freed).
 *  - triage             → drop every task in the batch.
 *  - unblock            → drop dep edges into the task (frees its ordering).
 *  - reschedule_deadline→ move the project's deadline (what `globalForecast` gates on).
 *  - reschedule_task    → near-noop: the project deadline gates the joint odds,
 *                         not a task's own due date (alloc tasks carry no due date).
 *  - reshape            → scope_down shrinks the task's estimate in place; split
 *                         drops the monolith and injects the lighter steps.
 *  - add_tasks          → inject the new tasks for the move's project.
 *  - reroute            → drop the replaced tasks, inject the alternative plan.
 *  - skip_activity      → add skip rows for this activity's CURRENT-week owed
 *                         instances, freeing its drain from capacity (matches the
 *                         apply, which persists exactly those skips).
 *  - hold               → no-op.
 *
 * This is the FORECAST-domain twin of each kind's `persist` in the server-only
 * `MOVE_SPECS` registry (lib/store.ts): the previewed odds come from here, the real
 * mutation from there, and the two MUST encode the same effect (§0). They live in
 * separate modules only because this one runs CLIENT-SIDE during live re-solve; both
 * are exhaustive over `StrategyMoveKind`, so a new kind needs an arm in both.
 */
export function applyMoveToAlloc(
  g: MovePatchContext,
  state: AllocState,
  move: StrategyMove,
): AllocState {
  const p = move.payload;
  const projectName =
    move.projectName ||
    state.tasks.find((t) => t.projectId === move.projectId)?.projectName ||
    "";

  switch (p.kind) {
    case "defer":
    case "mark_done":
      return { ...state, tasks: state.tasks.filter((t) => t.id !== p.taskId) };

    case "triage": {
      const drop = new Set(p.taskIds);
      return { ...state, tasks: state.tasks.filter((t) => !drop.has(t.id)) };
    }

    case "unblock":
      return { ...state, deps: state.deps.filter((d) => d.task_id !== p.taskId) };

    case "reschedule_deadline": {
      const deadlineByProject = new Map(state.deadlineByProject);
      deadlineByProject.set(move.projectId, p.deadline);
      return { ...state, deadlineByProject };
    }

    case "reschedule_task":
      // Near-noop on the joint odds (the project deadline is the gate).
      return state;

    case "skip_activity": {
      const activity = g.activities.find((a) => a.id === p.activityId);
      if (!activity) return state;
      const dates = currentWeekOwedDates(activity, g.completions, g.today);
      if (dates.length === 0) return state;
      const skips: ActivityCompletion[] = dates.map((date) => ({
        id: "",
        activity_id: activity.id,
        date,
        minutes: 0,
        skipped: true,
        created_at: "",
      }));
      return { ...state, skipCompletions: [...state.skipCompletions, ...skips] };
    }

    case "reshape": {
      let tasks = state.tasks;
      for (const mod of p.mods) {
        if (mod.kind === "scope_down") {
          const lighter = mod.replacements[0];
          if (!lighter) continue;
          tasks = tasks.map((t) =>
            t.id === mod.taskId
              ? { ...t, estimatedMinutes: lighter.estimated_minutes }
              : t,
          );
        } else {
          // split: the monolith leaves the plan, its steps take its place.
          tasks = tasks.filter((t) => t.id !== mod.taskId);
          tasks = [
            ...tasks,
            ...mod.replacements.map((part, i) =>
              syntheticAllocTask(
                `synth:reshape:${mod.taskId}:${i}`,
                move.projectId,
                projectName,
                part.title,
                part.estimated_minutes,
                part,
              ),
            ),
          ];
        }
      }
      return { ...state, tasks };
    }

    case "add_tasks": {
      const injected = p.tasks.map((t, i) =>
        syntheticAllocTask(
          `synth:add:${move.projectId}:${i}`,
          move.projectId,
          projectName,
          t.title,
          t.estimated_minutes,
          t,
        ),
      );
      return { ...state, tasks: [...state.tasks, ...injected] };
    }

    case "reroute": {
      const drop = new Set(p.replacedTaskIds);
      const remaining = state.tasks.filter((t) => !drop.has(t.id));
      const injected = p.tasks.map((t, i) =>
        syntheticAllocTask(
          `synth:reroute:${move.projectId}:${i}`,
          move.projectId,
          projectName,
          t.title,
          t.estimated_minutes,
          t,
        ),
      );
      return { ...state, tasks: [...remaining, ...injected] };
    }

    case "hold":
      return state;
  }
}

/**
 * One joint forecast of the whole portfolio after applying an ordered move set —
 * the contention-correct read of "do all of these." Folds each move into a
 * scratch alloc state, rebuilds the global order, and runs `globalForecastJoint`
 * over the transformed plan. `allOnTime` is the headline conjunction (P(all
 * deadlined projects land)); `byProject` lets the optimizer count who's on track.
 */
export function jointOddsWithMoves(
  g: JointForecastContext,
  ctx: AllocContext,
  moves: StrategyMove[],
  iterations?: number,
): { byProject: Map<string, number>; allOnTime: number } {
  let state: AllocState = {
    tasks: ctx.tasks,
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    skipCompletions: [],
  };
  for (const move of moves) state = applyMoveToAlloc(g, state, move);

  const plan = buildGlobalPlan({
    tasks: state.tasks,
    deps: state.deps,
    deadlineByProject: state.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  });
  // A skip-move frees that activity's current-week hours: recompute capacity with
  // its drain removed (re-drained over completions + the synthetic skips). Reuses
  // the base capacities when no skip-move is in the set (the common case).
  const capacities = state.skipCompletions.length
    ? dayCapacities(
        {
          availability: g.availability,
          overrides: g.overrides,
          commitments: [
            ...g.realCommitments,
            ...drainAsCommitments(
              g.activities,
              [...g.completions, ...state.skipCompletions],
              g.today,
            ),
          ],
        },
        g.today,
      )
    : ctx.capacities;
  const opts: ForecastOptions = {
    ...forecastOptions(g.model),
    ...(iterations !== undefined ? { iterations } : {}),
  };
  // Comfort cap takes precedence over windowed pricing (mirrors the forecast's in-loop
  // precedence + `comfortSmooth`'s gated call): when the base plan afforded a humaner
  // pace, every move-set is metered by that one cap; otherwise price the order's windows.
  // Either is derived from THIS pass's capacities (skip-adjusted when a skip-move freed
  // hours), so a preview prices exactly as the dashboard headline does.
  if (g.comfortCapMinutes != null) {
    opts.comfortCapMinutes = g.comfortCapMinutes;
  } else if (g.windowProfile) {
    opts.windowCapacities = windowCapacities(capacities, g.windowProfile);
  }
  // S3b Phase 3 slice 3 — replay the within-day reorder decided on the base, when set:
  // re-sequence this subset's order (group projects + slot hard work into fast windows)
  // before pricing. Deterministic over inputs the client mirrors (order, the same
  // skip-adjusted capacities, deps, profile, cap), so server == client for the subset.
  const order = g.arrangeReorder
    ? arrangeOrder(plan.order, capacities, state.deps, g.today, {
        windowProfile: g.windowProfile,
        comfortCapMinutes: g.comfortCapMinutes,
      })
    : plan.order;
  return globalForecastJoint(order, capacities, state.deadlineByProject, g.today, opts);
}

/**
 * The cumulative scorer for the display (decision #5): the running portfolio
 * `allOnTime` after each prefix of the ordered moves, climbing to the combined
 * total (== the last entry). Full iterations — these are the numbers the card
 * shows. `combined` falls back to the base joint odds when there are no moves.
 */
export function cumulativeJointOdds(
  g: JointForecastContext,
  ctx: AllocContext,
  ordered: StrategyMove[],
): { afterEach: number[]; combined: number } {
  const afterEach = ordered.map(
    (_, i) => jointOddsWithMoves(g, ctx, ordered.slice(0, i + 1)).allOnTime,
  );
  const combined = afterEach.length
    ? afterEach[afterEach.length - 1]
    : jointOddsWithMoves(g, ctx, []).allOnTime;
  return { afterEach, combined };
}

// --- Client-side live re-solve (OVERHAUL S1, vision §8.2) --------------------
//
// The review screen lets the user toggle individual moves in/out and see the
// outcome recompute BEFORE accepting. Moves interact (two freeing the same hours
// are sub-additive; reroute + defer of the same task collide), so a subset's odds
// can't be read off per-move deltas — you must recompose the selected set and
// re-run the joint MC. `ResolveInput` is the serialized, plain-JSON snapshot of
// the generation-time gather slice that lets the SAME seeded `globalForecastJoint`
// run in the browser: identical inputs + identical iteration count (5000) ⇒ the
// live subset number EQUALS the server's baked `portfolioProbabilityAfter` for
// that same subset. §0 holds — the odds still come from `forecast()`; the browser
// merely relocates a deterministic computation it cannot author.

/**
 * The serialized inputs shipped to the client so it can re-solve an arbitrary move
 * subset. All plain JSON (the Map is sent as entries). `capacities` is the floored
 * BASE per-day series (recurring drain already folded in) — used for the global order
 * and the no-skip Monte Carlo, so those paths stay byte-identical to the server.
 *
 * A skip-move frees its recurring drain back to the pool. Rather than ship a per-skip
 * floored vector (which under-counts when two skips share an over-subscribed day), we
 * ship the raw ingredients: `baseSlackHours` (the SIGNED, unfloored base slack) and
 * `skipDrainHoursByActivity` (each activity's freed drain). The client adds the
 * selected skips' drain onto the signed slack and floors ONCE — composing any subset
 * EXACTLY as the server's `jointOddsWithMoves` recompute does. (Odds, by contrast, are
 * NOT additive at all — hence the full re-solve.)
 */
export interface ResolveInput {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  capacities: DayCapacity[];
  /** Entries of the deadline-by-project Map (JSON-safe; rebuilt client-side). */
  deadlineByProject: [string, string | null][];
  today: string;
  model: { meanLog: number; sigma: number };
  /** SIGNED, unfloored base slack in hours per day (index-aligned to `capacities`);
   *  `capacities[i]` is its floor: round(max(0, baseSlackHours[i])*60). Signed so a
   *  multi-skip re-solve can add drain back and floor once (exact). */
  baseSlackHours: number[];
  /** activityId → per-day HOURS freed by skipping it this week. Added onto
   *  `baseSlackHours` (then floored once) for any selected skip subset. Present for
   *  every active activity (a zero series when nothing is owed this week). */
  skipDrainHoursByActivity: Record<string, number[]>;
  /** OVERHAUL S3b Phase 2 — the per-window velocity profile (null/absent when unlearned).
   *  The client rebuilds window segments from its OWN (skip-adjusted) capacities + this
   *  static profile, so the windowed re-solve stays bit-identical to the server's for the
   *  same subset (the 14/14 parity rides on the existing capacity parity). */
  windowProfile?: WindowProfile | null;
  /** OVERHAUL S3b Phase 3 slice 2 — the single comfort cap (hard minutes/day) the server
   *  decided on the base order, or null when none was afforded. The client meters every
   *  subset re-solve by it (the comfort flow is deterministic and the per-task `difficulty`
   *  already rides on `tasks`, so the re-solve stays bit-identical); takes precedence over
   *  `windowProfile`, matching the server's `jointOddsWithMoves`. */
  comfortCapMinutes?: number | null;
  /** OVERHAUL S3b Phase 3 slice 3 — the within-day reorder flag the scorer decided on the
   *  base order. When set, the client replays the SAME deterministic `arrangeOrder` on its
   *  re-derived order before pricing (reads only `tasks`/`deps`/`capacities`/`windowProfile`/
   *  `comfortCapMinutes`/`today`, all already shipped, so the re-solve stays bit-identical
   *  to the server's `jointOddsWithMoves`). */
  arrangeReorder?: boolean;
}

/** Element-wise sum of two per-day hour series (aligned by index — both span the same
 *  horizon + anchor). Folds selected skips' freed drain together before the re-solve. */
function addHourVectors(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + (b[i] ?? 0));
}

/**
 * The client twin of `jointOddsWithMoves`: re-solve the portfolio odds for a move
 * subset from a serialized `ResolveInput`, with NO server round-trip. Composes the
 * selected moves (skip-moves fold in as a base-additive capacity bump; every other
 * move is the same pure `applyMoveToAlloc` transform), builds the order from the
 * BASE capacities, and runs the joint MC over the skip-freed capacities — mirroring
 * the server exactly so the number is identical for the same subset.
 */
export function resolveSubsetOdds(
  input: ResolveInput,
  moves: StrategyMove[],
): { byProject: Map<string, number>; allOnTime: number } {
  // Skip-moves only touch capacity (via their baked vectors); the stub context is
  // never read for any other kind, so the client needs no activities/completions.
  const stub: MovePatchContext = {
    activities: [],
    completions: [],
    today: input.today,
  };
  let state: AllocState = {
    tasks: input.tasks,
    deps: input.deps,
    deadlineByProject: new Map(input.deadlineByProject),
    skipCompletions: [],
  };
  let skipDrain: number[] | null = null;
  for (const move of moves) {
    if (move.payload.kind === "skip_activity") {
      const vec = input.skipDrainHoursByActivity[move.payload.activityId];
      if (vec) skipDrain = skipDrain ? addHourVectors(skipDrain, vec) : vec.slice();
    } else {
      state = applyMoveToAlloc(stub, state, move);
    }
  }
  // The order is always built from the BASE capacities (server computes it from
  // `ctx.budget`, unaffected by skips); only the MC sees the freed capacity.
  const baseOrder = effectiveOrder(
    state.tasks,
    state.deps,
    state.deadlineByProject,
    input.capacities,
    input.today,
  );
  // No skip selected → the byte-identical base capacities. Otherwise add the selected
  // skips' freed drain onto the SIGNED base slack and floor ONCE, mirroring the server's
  // `dayCapacities` recompute exactly (no per-skip under-count on over-subscribed days).
  const capacities = skipDrain
    ? input.capacities.map((c, i) => ({
        iso: c.iso,
        capacityMinutes: Math.round(
          Math.max(0, input.baseSlackHours[i] + skipDrain![i]) * 60,
        ),
      }))
    : input.capacities;
  // S3b Phase 3 slice 3 — replay the within-day reorder the server decided on the base
  // (group projects + slot hard work into fast windows), over the SAME skip-adjusted
  // capacities the server's `jointOddsWithMoves` buckets by — so the arranged order is
  // bit-identical to the server's for this subset.
  const order = input.arrangeReorder
    ? arrangeOrder(baseOrder, capacities, state.deps, input.today, {
        windowProfile: input.windowProfile,
        comfortCapMinutes: input.comfortCapMinutes,
      })
    : baseOrder;
  const opts: ForecastOptions = {
    sigma: input.model.sigma,
    meanLog: input.model.meanLog,
  };
  // Mirror the server's `jointOddsWithMoves` precedence exactly: the comfort cap (when the
  // server afforded one) meters this subset by the same scalar — the comfort flow is
  // deterministic and `difficulty` already rides on `tasks`, so the re-solve stays
  // bit-identical; otherwise rebuild window segments from the client's own (skip-adjusted)
  // capacities + the shipped profile.
  if (input.comfortCapMinutes != null) {
    opts.comfortCapMinutes = input.comfortCapMinutes;
  } else if (input.windowProfile) {
    opts.windowCapacities = windowCapacities(capacities, input.windowProfile);
  }
  return globalForecastJoint(
    order,
    capacities,
    state.deadlineByProject,
    input.today,
    opts,
  );
}

/**
 * The client twin of `cumulativeJointOdds`: the running portfolio odds after each
 * prefix of the (selected, recommended-order) moves — for the review screen's live
 * per-move "all →" numbers and the headline (the last entry). `combined` falls back
 * to the base joint odds when no moves are selected.
 */
export function resolveSubsetCumulative(
  input: ResolveInput,
  ordered: StrategyMove[],
): { afterEach: number[]; combined: number } {
  const afterEach = ordered.map(
    (_, i) => resolveSubsetOdds(input, ordered.slice(0, i + 1)).allOnTime,
  );
  const combined = afterEach.length
    ? afterEach[afterEach.length - 1]
    : resolveSubsetOdds(input, []).allOnTime;
  return { afterEach, combined };
}
