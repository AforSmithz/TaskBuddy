// The portfolio's forecast()-domain state plus the pure move-patch engine. Pulled out of the
// server-only store.ts so it's genuinely CLIENT-SAFE: no DB, no `server-only`, no gather
// machinery. Two features ride on it - live re-solve on the review screen, and whole-strategy
// undo / plan version history. See design/s1-patch-snapshot-model.md.
//
// Everything here is pure: identical inputs give an identical number across processes (the
// seeded Monte Carlo guarantees it) and nothing mutates the base gather. The functions take a
// narrow slice of the gather rather than the full server-side type, which is what keeps this
// module free of `server-only`.

import type {
  ActivityCompletion,
  Availability,
  AvailabilityOverride,
  Commitment,
  EffectiveOrderEntry,
  EstimationModel,
  FactorScores,
  RecurringActivity,
  StrategyMove,
} from "@/lib/types";
import { computePriority } from "@/lib/priority";
import { dayCapacities, type DayCapacity, type DependencyEdge } from "@/lib/schedule";
import { globalForecastJoint, type ForecastOptions } from "@/lib/forecast";
import {
  buildGlobalPlan,
  effectiveOrder,
  effortToDifficulty,
  SKILL_TASK_PREFIX,
  type AllocTask,
} from "@/lib/allocate";
import { activityDrainCommitments, currentWeekOwedDates } from "@/lib/recurring";
import { arrangeOrder, windowCapacities, type ArrangeWeights, type WindowProfile } from "@/lib/arrange";

/** The slice of the server gather a move's pure forecast-patch reads. Only the
 *  skip-move arm touches the gather (to find the activity's owed dates); every
 *  other move is a pure transform of `AllocState`. The full `ForecastGather`
 *  structurally satisfies this. */
export interface MovePatchContext {
  activities: RecurringActivity[];
  completions: ActivityCompletion[];
  today: string;
}

/** The slice of the server gather the joint re-solve reads - a superset of
 *  `MovePatchContext` (it folds moves in, then re-runs the joint forecast()). The
 *  full `ForecastGather` structurally satisfies this too, so the extraction
 *  needs no change at the call sites. */
export interface JointForecastContext extends MovePatchContext {
  deadlineByProject: Map<string, string | null>;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  realCommitments: Commitment[];
  model: EstimationModel;
  /** the per-window velocity profile (null when unlearned).
   *  When present, the joint re-solve flows over window segments derived from THIS
   *  pass's capacities, so a move preview prices time-of-day velocity exactly as the
   *  dashboard headline does. `ForecastGather` structurally satisfies it. */
  windowProfile?: WindowProfile | null;
  /** The one comfort cap (hard minutes/day) the scorer decided on the base order, or null when
   *  no humaner pace was affordable. When set it meters every re-solve so the strategy page
   *  quotes the same capped plan the dashboard shows. Composes with windowProfile. */
  comfortCapMinutes?: number | null;
  /** When set, replay the within-day reorder the scorer decided on the base order: re-sequence
   *  this subset's order with arrangeOrder before pricing. Decided once on the base, not
   *  re-gated per subset. */
  arrangeReorder?: boolean;
  /** projectId -> thin-buffer urgency (0,1] under the base plan. The reorder biases an at-risk
   *  project's work into fast windows in proportion to how thin it is. Decided once on the base
   *  because it can't be recomputed from this context's data. */
  thinBufferUrgency?: ReadonlyMap<string, number> | null;
  /** the calibrated soft-`J` term weights (`ArrangeWeights`) the
   *  server's reorder used, learned from the drag-to-reorder history. Fed to `arrangeOrder` so a
   *  move probe's within-day reorder weights `φ` exactly as the base did. Absent/prior `{1,1,1}`
   *  ⇒ the default weights, a no-op (no-regret). */
  arrangeWeights?: ArrangeWeights | null;
  /** When a STICKY committed plan is showing, its order as a task-id sequence (already
   *  reconciled). The base subset prices it VERBATIM - the server already arranged and gated it
   *  which keeps the base re-solve client==server exact. Move-probes ignore it: a strategy
   *  move is a re-plan, not a sticky hold. */
  committedOrder?: string[] | null;
}

/** The forecast's per-iteration estimation-bias options, drawn from the user's
 *  calibrated model. The single place that maps a model → forecast() opts, so every
 *  forecast() pass (per-project, joint, recovery) calibrates identically. */
export function forecastOptions(model: EstimationModel) {
  return { sigma: model.sigma, meanLog: model.meanLog };
}

/** The recurring drain (routines/goals) as synthetic commitments, so the time
 *  budget reserves their hours. Folded into capacity wherever the forecast() runs;
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

/** Shared inputs for one global allocation pass: alloc tasks, dep edges, and per-day
 *  capacities under a commitment set. Built once so odds, conflict detection and triage probes
 *  all reason over the same contention picture. */
export interface AllocContext {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  budget: { availability: Availability[]; overrides: AvailabilityOverride[]; commitments: Pick<Commitment, "date" | "hours">[] };
  capacities: ReturnType<typeof dayCapacities>;
}

// --- Joint scoring of a move combination -----------------------------------
//
// The strategy needs the TRUE joint odds of a SET of moves, not the solo per-project odds each
// carries. These apply an ordered combination to a scratch copy of the alloc state and re-run
// globalForecastJoint over it, so the moves interact through the shared hour pool exactly as
// they will once applied.

/** The mutable surface a move transforms: the alloc tasks, dep edges, deadlines,
 *  plus synthetic skip rows a `skip_activity` move adds (which re-drain capacity). */
export interface AllocState {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  deadlineByProject: Map<string, string | null>;
  skipCompletions: ActivityCompletion[];
}

/** Skill alloc-task ids are namespaced so they never collide with real task uuids. Defined in
 *  allocate.ts, re-exported here because the attain_skill/defer_skill arms below run
 *  CLIENT-side during live re-solve and must rebuild the same id from a node id. */
export { SKILL_TASK_PREFIX };

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
 * Pure transform of the scratch alloc state for ONE move. Returns a NEW AllocState, never
 * mutating the base, so prefixes can be scored independently. Each move maps to the alloc-level
 * effect its real apply has on the forecast():
 *   defer / mark_done     drop the task, freeing its budget
 *   triage                drop every task in the batch
 *   unblock               drop dep edges into the task
 *   resolve_blocker       drop the blocker AND every edge pointing AT it (the opposite edge
 *                         direction from unblock), freeing its direct dependents
 *   reschedule_deadline   move the project's deadline
 *   reschedule_task       near-noop; the project deadline gates joint odds, not a task due date
 *   reshape               scope_down shrinks the estimate in place, split drops the monolith
 *                         and injects the lighter steps
 *   add_tasks / reroute   inject new tasks (reroute also drops the replaced ones)
 *   skip_activity         add skip rows for this week's owed instances, freeing the drain
 *   hold                  no-op
 *
 * This is the forecast()-domain twin of each kind's `persist` in MOVE_SPECS (store.ts): previewed
 * odds come from here, the real mutation from there, and the two MUST encode the same effect.
 * They're separate modules only because this one runs client-side. Both are exhaustive over
 * StrategyMoveKind, so a new kind needs an arm in each.
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

    case "attain_skill":
      // Attaining a skill drops its synthetic forecast() task (id `skill:`+nodeId),
      // freeing the budget it occupied - the same "drop a task by id" mechanic as
      // mark_done. This is why attain_skill is Family A (a non-identity arm).
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== SKILL_TASK_PREFIX + p.nodeId),
      };

    case "defer_skill":
      // Parking a skill node drops its synthetic forecast() task, freeing its budget
      // the SAME drop mechanic as attain_skill, but the node is set aside, not
      // demonstrated. The enumerator guarantees it is never a checkpoint.
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== SKILL_TASK_PREFIX + p.nodeId),
      };

    case "reschedule_skill": {
      // Re-phasing a milestone chain parks its whole node set (checkpoint + exclusive
      // prep); drop each parked node's `skill:`+id synthetic task, freeing their
      // combined budget - the defer_skill drop mechanic generalized to a set (as triage
      // does for real tasks). The enumerator guarantees the set is strand-free.
      const drop = new Set(p.parkNodeIds.map((id) => SKILL_TASK_PREFIX + id));
      return { ...state, tasks: state.tasks.filter((t) => !drop.has(t.id)) };
    }

    case "triage": {
      const drop = new Set(p.taskIds);
      return { ...state, tasks: state.tasks.filter((t) => !drop.has(t.id)) };
    }

    case "unblock":
      return { ...state, deps: state.deps.filter((d) => d.task_id !== p.taskId) };

    case "resolve_blocker":
    // Resolving a blocker drops it (freeing its budget, like mark_done) and removes every
    // edge INTO it so its dependents stop being topo-gated. Dropping the task alone would
    // already free them via allocate.ts's both-endpoints-open guard; the explicit filter
    // mirrors persist and stays correct even if the blocker isn't an open alloc task.
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== p.blockerTaskId),
        deps: state.deps.filter((d) => d.depends_on_task_id !== p.blockerTaskId),
      };

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

/** Reorder a canonical order to a committed task-id sequence (sticky replay). Unknown ids are
 *  skipped and unnamed entries are appended in canonical position - defensive against drift,
 *  though the server reconciles before shipping so in practice `ids` is a permutation. Building
 *  the entries from the same source both sides derive, then reordering by the shared id
 *  sequence, is what keeps the sticky base re-solve exact. */
function orderByCommitted(
  entries: EffectiveOrderEntry[],
  ids: string[],
): EffectiveOrderEntry[] {
  const byId = new Map(entries.map((e) => [e.taskId, e]));
  const seen = new Set<string>();
  const out: EffectiveOrderEntry[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (e && !seen.has(id)) {
      out.push(e);
      seen.add(id);
    }
  }
  for (const e of entries) if (!seen.has(e.taskId)) out.push(e);
  return out;
}

/** One joint forecast of the whole portfolio after applying an ordered move set - the
 *  contention-correct read of "do all of these". Folds each move into a scratch alloc state,
 *  rebuilds the global order, and runs globalForecastJoint over it. */
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
  // Comfort cap and windowed pricing compose: when the base plan afforded a humaner pace every
  // move-set is metered by that cap, and the order's windows are priced when a profile is
  // learned. Both derive from THIS pass's capacities (skip-adjusted when a skip freed hours),
  // so a preview prices exactly as the dashboard headline does.
  if (g.comfortCapMinutes != null) opts.comfortCapMinutes = g.comfortCapMinutes;
  if (g.windowProfile) opts.windowCapacities = windowCapacities(capacities, g.windowProfile);
  // A STICKY committed plan prices its order VERBATIM for the base subset: the server already
  // arranged and gated it, so bypass the reorder and just replay the sequence. Only the empty
  // subset is sticky - a strategy move re-plans, so non-empty subsets fall through to the fresh
  // arrangement below and replay the reorder decided on the base.
  const order =
    moves.length === 0 && g.committedOrder
      ? orderByCommitted(plan.order, g.committedOrder)
      : g.arrangeReorder
        ? arrangeOrder(plan.order, capacities, state.deps, g.today, {
            windowProfile: g.windowProfile,
            comfortCapMinutes: g.comfortCapMinutes,
            thinBufferUrgency: g.thinBufferUrgency,
            weights: g.arrangeWeights ?? undefined,
          })
        : plan.order;
  return globalForecastJoint(order, capacities, state.deadlineByProject, g.today, opts);
}

/** The cumulative scorer for the display: running portfolio allOnTime after each prefix of the
 *  ordered moves, climbing to the combined total. Full iterations - these are the numbers the
 *  card shows. `combined` falls back to base odds when there are no moves. */
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

// --- Client-side live re-solve ---------------------------------------------
//
// The review screen lets the user toggle moves in and out and see the outcome recompute before
// accepting. Moves interact (two freeing the same hours are sub-additive; a reroute and a defer
// of the same task collide), so a subset's odds can't be read off per-move deltas - you have to
// recompose the set and re-run the joint MC. ResolveInput is the plain-JSON snapshot that lets
// the SAME seeded globalForecastJoint run in the browser: identical inputs and iteration count
// mean the live number EQUALS the server's baked one for that subset. The odds still come from
// forecast(); the browser just relocates a deterministic computation it can't author.

/** The serialized inputs shipped to the client so it can re-solve an arbitrary move subset. All
 *  plain JSON. `capacities` is the floored BASE per-day series (recurring drain folded in),
 *  used for the global order and the no-skip MC so those stay byte-identical to the server.
 *
 *  A skip-move frees its drain back to the pool. Rather than ship a per-skip floored vector
 *  (which under-counts when two skips share an over-subscribed day) we ship the raw
 *  ingredients: the SIGNED unfloored base slack, and each activity's freed drain. The client
 *  adds the selected skips onto the signed slack and floors ONCE, composing any subset exactly
 *  as the server does. Odds, by contrast, aren't additive at all - hence the full re-solve. */
export interface ResolveInput {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  capacities: DayCapacity[];
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
  /** the per-window velocity profile (null/absent when unlearned).
   *  The client rebuilds window segments from its OWN (skip-adjusted) capacities + this
   *  static profile, so the windowed re-solve stays bit-identical to the server's for the
   *  same subset (the 14/14 parity rides on the existing capacity parity). */
  windowProfile?: WindowProfile | null;
  /** The comfort cap the server decided on the base order, or null. The client meters every
   *  subset re-solve by it - the comfort flow is deterministic and per-task difficulty already
   *  rides on `tasks`, so the re-solve stays bit-identical. */
  comfortCapMinutes?: number | null;
  /** The within-day reorder flag decided on the base order. When set the client replays the
   *  same deterministic arrangeOrder before pricing; it reads only fields already shipped. */
  arrangeReorder?: boolean;
  /** projectId -> thin-buffer urgency, as a JSON-safe record. The client rebuilds the Map and
   *  feeds the same arrangeOrder. It can't be recomputed here - the buffer math needs the
   *  per-project forecast() distribution the server holds. */
  thinBufferUrgency?: Record<string, number>;
  /** the calibrated soft-`J` term weights the server's reorder used
   *  (learned from the drag-to-reorder history). The client feeds them to the SAME `arrangeOrder`
   *  so its within-day reorder weights `φ` bit-identically to the server's. Prior `{1,1,1}` /
   *  absent ⇒ the default weights, a no-op (no-regret). */
  arrangeWeights?: ArrangeWeights;
  /** When a sticky plan is shown, its committed order as a task-id sequence. The client prices
   *  the base subset by replaying it verbatim over its own re-derived entries instead of
   *  re-arranging. Non-empty subsets ignore it. */
  committedOrder?: string[];
}

/** Element-wise sum of two per-day hour series (aligned by index - both span the same
 *  horizon + anchor). Folds selected skips' freed drain together before the re-solve. */
function addHourVectors(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + (b[i] ?? 0));
}

/** The client twin of jointOddsWithMoves: re-solve portfolio odds for a move subset from a
 *  serialized ResolveInput, no round-trip. Composes the selected moves (skips fold in as a
 *  base-additive capacity bump, everything else is the same applyMoveToAlloc transform), builds
 *  the order from BASE capacities, and runs the joint MC over the skip-freed ones. */
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
    // A sticky plan prices the base subset by replaying the committed order verbatim over the
    // client's own re-derived entries, mirroring the server's sticky branch. A non-empty subset
    // re-plans and falls through to the fresh arrangement, replaying the reorder the server
    // decided on the base.
  const order =
    moves.length === 0 && input.committedOrder
      ? orderByCommitted(baseOrder, input.committedOrder)
      : input.arrangeReorder
        ? arrangeOrder(baseOrder, capacities, state.deps, input.today, {
            windowProfile: input.windowProfile,
            comfortCapMinutes: input.comfortCapMinutes,
            // Same urgency map the server flagged on the base - replayed, not recomputed (parity).
            thinBufferUrgency: input.thinBufferUrgency
              ? new Map(Object.entries(input.thinBufferUrgency))
              : null,
            // Same calibrated weights the server used - replayed so `φ` is weighted identically.
            weights: input.arrangeWeights ?? undefined,
          })
        : baseOrder;
  const opts: ForecastOptions = {
    sigma: input.model.sigma,
    meanLog: input.model.meanLog,
  };
  // Mirror the server's composition exactly: the comfort cap meters this subset by the same
  // scalar, and window segments are rebuilt from the client's own skip-adjusted capacities plus
  // the shipped profile.
  if (input.comfortCapMinutes != null) opts.comfortCapMinutes = input.comfortCapMinutes;
  if (input.windowProfile) opts.windowCapacities = windowCapacities(capacities, input.windowProfile);
  return globalForecastJoint(
    order,
    capacities,
    state.deadlineByProject,
    input.today,
    opts,
  );
}

/** The client twin of cumulativeJointOdds: running odds after each prefix of the selected
 *  moves, for the review screen's live per-move numbers and the headline. */
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
