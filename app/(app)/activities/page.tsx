import { Plus, Repeat, Target } from "lucide-react";
import { getRecurringState } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Reveal } from "@/components/motion/reveal";
import { ActivityForm } from "@/components/activities/activity-form";
import { ActivityRow } from "@/components/activities/activity-row";

export default async function ActivitiesPage() {
  const states = await getRecurringState();
  const routines = states.filter((s) => s.activity.period === "day");
  const goals = states.filter((s) => s.activity.period === "week");

  return (
    <main className="mx-auto max-w-[820px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Routines & goals"
          description="The recurring things you want to keep up — daily routines you build a streak on, and weekly goals you make steady progress toward. They compete for the same hours as your projects."
        />
      </Reveal>

      <Reveal delay={0.05} className="mt-7">
        <Card>
          <CardHeader
            title="Add a routine or goal"
            icon={<Plus className="size-4 text-[var(--color-accent)]" />}
          />
          <ActivityForm />
        </Card>
      </Reveal>

      <Reveal delay={0.1} className="mt-7">
        <Card>
          <CardHeader
            title="Routines"
            icon={<Repeat className="size-4" />}
          />
          {routines.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Repeat}
                title="No routines yet"
                description="Add a daily habit above — read, meditate, work out — and build a streak."
              />
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {routines.map((s) => (
                <ActivityRow key={s.activity.id} state={s} />
              ))}
            </div>
          )}
        </Card>
      </Reveal>

      <Reveal delay={0.15} className="mt-7">
        <Card>
          <CardHeader title="Goals" icon={<Target className="size-4" />} />
          {goals.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Target}
                title="No goals yet"
                description="Add a weekly goal above — practice piano 3× a week, run twice — and track steady progress."
              />
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {goals.map((s) => (
                <ActivityRow key={s.activity.id} state={s} />
              ))}
            </div>
          )}
        </Card>
      </Reveal>
    </main>
  );
}
