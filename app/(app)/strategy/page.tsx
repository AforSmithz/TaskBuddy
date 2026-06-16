import { Compass, AlertTriangle, ShieldCheck } from "lucide-react";
import {
  forecastDashboard,
  getAutoStrategy,
  getCachedStrategy,
  listAllTasks,
} from "@/lib/store";
import {
  assessStaleness,
  deterministicStrategyFrom,
} from "@/lib/portfolio-strategist";
import { isLLMConfigured } from "@/lib/extraction";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Reveal } from "@/components/motion/reveal";
import { StrategyCard } from "@/components/strategy/strategy-card";
import { ProjectDisclosure } from "@/components/strategy/project-disclosure";
import { PitWallCallout } from "@/components/forecast/pit-wall-callout";

export default async function StrategyPage() {
  const [dashboard, autoStrategy, cached, tasks] = await Promise.all([
    forecastDashboard(),
    getAutoStrategy(),
    getCachedStrategy(),
    listAllTasks(),
  ]);
  const { forecasts, recoveries, pitWall, globalPlan } = dashboard;
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  // taskId → project name (every open task is in the global order) so the card can
  // tag deferred tasks with their project — needed for cross-project triage.
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
          description="The full picture behind your portfolio recommendation — contention, automation, and per-project options."
        />
      </Reveal>

      {/* The synthesized recommendation — same card as Today, with refresh. */}
      <Reveal delay={0.05} className="mt-7">
        <StrategyCard
          strategy={strategy}
          stale={strategyStale}
          canUseLLM={canUseLLM}
          projectNames={projectNames}
          steadyPlanDefaultOpen
          severity={bannerSeverity}
        />
      </Reveal>

      {/* The pit wall — cross-project contention + the Auto/Manual toggle. */}
      <Reveal delay={0.1} className="mt-7">
        <PitWallCallout pitWall={pitWall} autoStrategy={autoStrategy} />
      </Reveal>

      {/* Per-project breakdown — each off-track project's full recovery options,
          collapsed by default (expanding one mounts its heavy AI tools). */}
      <Reveal delay={0.15} className="mt-7">
        <Card>
          <CardHeader
            title="By project"
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
              No projects are off track — nothing needs per-project attention.
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
    </main>
  );
}
