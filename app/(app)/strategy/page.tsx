import { Compass, AlertTriangle, History, ShieldCheck } from "lucide-react";
import {
  forecastDashboard,
  getAutoStrategy,
  activeJobRun,
  getCachedStrategy,
  listAllTasks,
  listPlanRolls,
  listPlanVersions,
  listWorkSessions,
} from "@/lib/store";
import {
  assessStaleness,
  deterministicStrategyFrom,
} from "@/lib/portfolio-strategist";
import { diagnoseRoll } from "@/lib/rolling";
import { energyWindows, workSessionResidualSamples } from "@/lib/velocity";
import { isLLMConfigured } from "@/lib/extraction";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Reveal } from "@/components/motion/reveal";
import { StrategyCard } from "@/components/strategy/strategy-card";
import { PlanHistory } from "@/components/strategy/plan-history";
import { ProjectDisclosure } from "@/components/strategy/project-disclosure";
import { ReliableHours } from "@/components/strategy/reliable-hours";
import { PlanTuningCard } from "@/components/strategy/plan-tuning";
import { PitWallCallout } from "@/components/forecast/pit-wall-callout";

export default async function StrategyPage() {
  const [
    dashboard,
    autoStrategy,
    cached,
    tasks,
    planVersions,
    planRolls,
    workSessions,
    strategyJob,
  ] = await Promise.all([
    forecastDashboard(),
    getAutoStrategy(),
    getCachedStrategy(),
    listAllTasks(),
    listPlanVersions(),
    listPlanRolls(),
    listWorkSessions(),
    // A refresh in flight - possibly started from Today, since both pages
    // render this card and both auto-fire it. One job, either way.
    activeJobRun("strategy.refresh.requested"),
  ]);
  const { forecasts, recoveries, pitWall, globalPlan, tuning } = dashboard;
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  // "Why your plan changed" (S3c-3) - narrate each roll server-side by diffing it against the
  // roll it superseded (the next-older one; the list is newest-first, so index+1). Pure and
  // odds-free; the timeline renders the shipped string, computing nothing client-side.
  const rollCauses: Record<string, string> = {};
  for (let i = 0; i < planRolls.length; i++) {
    rollCauses[planRolls[i].id] = diagnoseRoll(
      planRolls[i],
      planRolls[i + 1] ?? null,
    ).summary;
  }

  // "Your reliable hours" (S2 slice C) - per-window velocity over real sessions,
  // calibrated to the same estimation bias the forecast uses. Empty until sessions
  // accrue, so only surface the card once there's at least one to read.
  const energy = energyWindows(
    workSessionResidualSamples(workSessions, tasksById),
    dashboard.model,
  );
  const totalSessions = energy.reduce((n, w) => n + w.sampleSize, 0);
  // taskId → project name (every open task is in the global order) so the card can
  // tag deferred tasks with their project - needed for cross-project triage.
  const projectNames = Object.fromEntries(
    globalPlan.order.map((o) => [o.taskId, o.projectName]),
  );

  // Same load contract as Today: render the cache (stale-marked if the odds moved
  // materially or it aged out), or a deterministic fallback when nothing is cached.
  // The card auto-regenerates in the background per the aggressive policy.
  const strategy =
    cached ?? deterministicStrategyFrom(recoveries, pitWall, forecasts, tasksById);
  const strategyStale = cached !== null && assessStaleness(cached, forecasts).stale;
  const canUseLLM = isLLMConfigured();
  const bannerSeverity = recoveries.some((p) =>
    p.reasons.some((r) => r.severity === "critical"),
  )
    ? "escalated"
    : "gentle";

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Strategy"
          description="The full picture behind your portfolio recommendation — contention, automation, and per-goal options."
        />
      </Reveal>

      {/* The synthesized recommendation - same card as Today, with refresh. */}
      <Reveal delay={0.05} className="mt-7">
        <StrategyCard
          strategy={strategy}
          stale={strategyStale}
          canUseLLM={canUseLLM}
          activeJob={strategyJob}
          projectNames={projectNames}
          steadyPlanDefaultOpen
          severity={bannerSeverity}
        />
      </Reveal>

      {/* The pit wall - cross-project contention + the Auto/Manual toggle. */}
      <Reveal delay={0.1} className="mt-7">
        <PitWallCallout pitWall={pitWall} autoStrategy={autoStrategy} />
      </Reveal>

      {/* Per-project breakdown - each off-track project's full recovery options,
          collapsed by default (expanding one mounts its heavy AI tools). */}
      <Reveal delay={0.15} className="mt-7">
        <Card>
          <CardHeader
            title="By goal"
            icon={
              recoveries.length > 0 ? (
                <AlertTriangle className="size-4 text-[var(--color-danger)]" />
              ) : (
                <Compass className="size-4" />
              )
            }
          />
          {recoveries.length === 0 ? (
            <p className="flex items-center gap-1.5 px-5 py-6 text-[13px] text-[var(--color-fg-muted)]">
              <ShieldCheck className="size-4 shrink-0 text-[var(--color-status-done)]" />
              No goals are off track — nothing needs per-goal attention.
            </p>
          ) : (
            <div className="space-y-2 p-3">
              {recoveries.map((plan) => (
                <ProjectDisclosure key={plan.projectId} plan={plan} />
              ))}
            </div>
          )}
        </Card>
      </Reveal>

      {/* Your reliable hours (S2 §5a) - per-window velocity from real sessions.
          Surfaced beside the strategist that uses the same read to temper its
          cause diagnosis; shown only once there's at least one session. */}
      {totalSessions > 0 && (
        <Reveal delay={0.2} className="mt-7">
          <ReliableHours windows={energy} />
        </Reveal>
      )}

      {/* How your plan is tuned to you (S3c-5 §5a) - the calibrated arrangement dials, plan
          stickiness, and recovery taste, learned from your drags, roll-undos, and the moves
          you keep vs decline. Shown once ANY tier has signal; each section shows its own
          still-learning state otherwise. */}
      {(tuning.arrange.samples > 0 ||
        tuning.stability.materialRolls > 0 ||
        tuning.movePrefs.samples > 0) && (
        <Reveal delay={0.22} className="mt-7">
          <PlanTuningCard tuning={tuning} />
        </Reveal>
      )}

      {/* Plan history - every applied bundle and every automatic roll, newest first,
          each with its own undo (vision §1.3). Shown only once there's something to record. */}
      {(planVersions.length > 0 || planRolls.length > 0) && (
        <Reveal delay={0.25} className="mt-7">
          <Card>
            <CardHeader title="Plan history" icon={<History className="size-4" />} />
            <PlanHistory
              versions={planVersions}
              rolls={planRolls}
              rollCauses={rollCauses}
            />
          </Card>
        </Reveal>
      )}
    </main>
  );
}
