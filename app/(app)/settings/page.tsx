import { SlidersHorizontal } from "lucide-react";
import {
  getValueModel,
  listAllTasks,
  listRecurringActivities,
} from "@/lib/store";
import { SEED_AREAS } from "@/lib/types";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Reveal } from "@/components/motion/reveal";
import { ValueModelForm } from "@/components/settings/value-model-form";

/**
 * Value Model settings (OVERHAUL §5 step 1). The areas shown are the seed areas
 * plus any life-area in actual use across tasks and routines, so the user weights
 * exactly the buckets their work falls into.
 */
export default async function SettingsPage() {
  const [model, tasks, activities] = await Promise.all([
    getValueModel(),
    listAllTasks(),
    listRecurringActivities(),
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
          <ValueModelForm model={model} areas={areas} />
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
    </main>
  );
}
