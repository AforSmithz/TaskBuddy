import Link from "next/link";
import { Plus, CalendarClock } from "lucide-react";
import { listAllTasks, listMeetings } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { MeetingListItem } from "@/components/meetings/meeting-list-item";
import { Reveal } from "@/components/motion/reveal";
import { TodayAgenda } from "@/components/today/today-agenda";

export default async function TodayPage() {
  const [tasks, meetings] = await Promise.all([
    listAllTasks(),
    listMeetings(),
  ]);

  const meetingTitles = Object.fromEntries(
    meetings.map((m) => [m.id, m.title]),
  );

  const taskCountByMeeting = new Map<string, { total: number; open: number }>();
  for (const t of tasks) {
    const entry = taskCountByMeeting.get(t.meeting_id) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (t.status !== "done") entry.open += 1;
    taskCountByMeeting.set(t.meeting_id, entry);
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Today"
          description={`${today} — what to focus on right now.`}
          actions={
            <Link href="/create" className={buttonClasses("primary", "md")}>
              <Plus className="size-4" />
              New Entry
            </Link>
          }
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-7">
        <TodayAgenda tasks={tasks} meetingTitles={meetingTitles} />
      </Reveal>

      <Reveal delay={0.2} className="mt-5">
        <Card>
          <CardHeader
            title="Recent activity"
            icon={<CalendarClock className="size-4" />}
          />
          {meetings.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing here yet"
              description="Add a meeting transcript or a personal goal to generate tasks."
              action={
                <Link
                  href="/create"
                  className={buttonClasses("primary", "sm")}
                >
                  <Plus className="size-4" />
                  New Entry
                </Link>
              }
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {meetings.map((m) => {
                const counts = taskCountByMeeting.get(m.id) ?? {
                  total: 0,
                  open: 0,
                };
                return (
                  <MeetingListItem
                    key={m.id}
                    id={m.id}
                    title={m.title}
                    summary={m.summary}
                    createdAt={m.created_at}
                    taskCount={counts.total}
                    openCount={counts.open}
                    kind={m.kind}
                  />
                );
              })}
            </div>
          )}
        </Card>
      </Reveal>
    </main>
  );
}
