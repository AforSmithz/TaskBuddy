import { Card, CardBody } from "@/components/ui/card";
import { EntryForm } from "@/components/create/entry-form";
import { listMeetings, listProjects } from "@/lib/store";

export const metadata = { title: "New Entry — TaskBuddy" };

export default async function CreatePage() {
  const [projects, meetings] = await Promise.all([
    listProjects(),
    listMeetings(),
  ]);

  return (
    <main className="mx-auto max-w-[720px] px-8 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-[var(--color-fg)]">
          Add to TaskBuddy
        </h1>
        <p className="mt-1.5 text-[15px] text-[var(--color-fg-muted)]">
          Turn a meeting transcript or a personal goal into a reviewed plan.
        </p>
      </div>
      <Card>
        <CardBody className="p-6">
          <EntryForm projects={projects} meetings={meetings} />
        </CardBody>
      </Card>
    </main>
  );
}
