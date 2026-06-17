import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Target, GitBranch, HelpCircle } from "lucide-react";
import { getEntry, listEntries, listGoals } from "@/lib/store";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { ReviewPanel } from "@/components/entries/review-panel";

export const metadata = { title: "Review — TaskBuddy" };

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [entry, projects, entries] = await Promise.all([
    getEntry(id),
    listGoals(),
    listEntries(),
  ]);
  if (!entry) notFound();
  // Only drafts are reviewable; a confirmed entry goes straight to its detail.
  if (entry.status !== "draft") redirect(`/entries/${id}`);

  const isPlan = entry.kind === "plan";

  return (
    <main className="mx-auto max-w-[820px] px-8 py-8">
      <Link
        href="/create"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-4" />
        Back to create
      </Link>

      <div className="mt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-fg)]">
          {isPlan ? "Review your plan" : "Review extracted tasks"}
        </span>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-[var(--color-fg)]">
          {entry.title}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
          Nothing is saved yet — accept the tasks you want, then confirm.
        </p>
      </div>

      {(entry.daily_objective || entry.summary) && (
        <Card className="mt-5">
          <CardBody className="space-y-3">
            {entry.daily_objective && (
              <div className="flex items-start gap-3 rounded-sm bg-[var(--color-accent-subtle)] px-4 py-3">
                <Target className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" />
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-fg)]">
                    {isPlan ? "Goal" : "Objective"}
                  </p>
                  <p className="mt-0.5 text-[14px] text-[var(--color-fg)]">
                    {entry.daily_objective}
                  </p>
                </div>
              </div>
            )}
            {entry.summary && (
              <p className="text-[14px] leading-relaxed text-[var(--color-fg)]">
                {entry.summary}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <div className="mt-5">
        <ReviewPanel
          entry={entry}
          projects={projects}
          entries={entries}
        />
      </div>

      {!isPlan && entry.decisions.length > 0 && (
        <Card className="mt-5">
          <CardHeader
            title="Decisions"
            icon={<GitBranch className="size-4" />}
            action={<Pill>{entry.decisions.length}</Pill>}
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {entry.decisions.map((d) => (
              <li
                key={d.id}
                className="px-5 py-3 text-[14px] text-[var(--color-fg)]"
              >
                {d.decision}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!isPlan && entry.open_questions.length > 0 && (
        <Card className="mt-5">
          <CardHeader
            title="Open questions"
            icon={<HelpCircle className="size-4" />}
            action={<Pill>{entry.open_questions.length}</Pill>}
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {entry.open_questions.map((q) => (
              <li
                key={q.id}
                className="px-5 py-3 text-[14px] text-[var(--color-fg)]"
              >
                {q.question}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
