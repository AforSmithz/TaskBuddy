import { Clock, SlidersHorizontal } from "lucide-react";
import {
  getValueModel,
  getWindowAvailability,
  listAllTasks,
  listGoals,
  listRecurringActivities,
  valueWeightsAffectPlan,
} from "@/lib/store";
import { SEED_AREAS } from "@/lib/types";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Reveal } from "@/components/motion/reveal";
import { ValueModelForm } from "@/components/settings/value-model-form";
import { WindowAvailabilityForm } from "@/components/settings/window-availability-form";

/**
 * Value Model settings. The areas shown are the seed areas
 * plus any life-area in actual use across tasks and routines, so the user weights
 * exactly the buckets their work falls into.
 */
export default async function SettingsPage() {
  const [model, windowAvailability, tasks, goals, activities, weightsActive] =
    await Promise.all([
      getValueModel(),
      getWindowAvailability(),
      listAllTasks(),
      listGoals(),
      listRecurringActivities(),
      valueWeightsAffectPlan(),
    ]);

  const areas = Array.from(
    new Set([
      ...SEED_AREAS,
      ...tasks.map((t) => t.area),
      ...activities.map((a) => a.area),
    ]),
  )
    .filter((a) => a.trim())
    .sort();

  return (
    <main className="mx-auto max-w-[820px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Value model"
          description="Tell TaskBuddy what matters to you. The strategist uses this to order your work and to choose how to recover when the week gets tight — so its plans reflect your priorities, not a default."
        />
      </Reveal>

      <Reveal delay={0.05} className="mt-7">
        <Card className="rounded-[22px] p-6 shadow-[var(--shadow-md)]">
          <ValueModelForm
            model={model}
            areas={areas}
            goals={goals.map((g) => ({ id: g.id, name: g.name }))}
            weightsActive={weightsActive}
          />
        </Card>
      </Reveal>

      <Reveal delay={0.1} className="mt-5">
        <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">
          <SlidersHorizontal className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This is v1 of the value model — area importance and recovery style.
            Finer controls (per-project weights, the urgency/impact/risk balance,
            and hard rules like &ldquo;never trade sleep&rdquo;) are coming. For now,
            protect a routine you won&apos;t sacrifice from its own page.
          </span>
        </p>
      </Reveal>

      <Reveal delay={0.15} className="mt-10">
        <PageHeader
          title="When you work"
          description="By default TaskBuddy learns which hours you tend to work from your sessions. Pin your hours here to override that — useful when the inferred pattern is wrong or you haven't logged much yet."
        />
      </Reveal>

      <Reveal delay={0.2} className="mt-7">
        <Card className="rounded-[22px] p-6 shadow-[var(--shadow-md)]">
          <WindowAvailabilityForm availability={windowAvailability} />
        </Card>
      </Reveal>

      <Reveal delay={0.25} className="mt-5">
        <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This shapes how your learned pace is spread across the day, so it only
            changes the plan once TaskBuddy has learned how fast you work in each
            window. Until then it&apos;s recorded but has no effect.
          </span>
        </p>
      </Reveal>
    </main>
  );
}
