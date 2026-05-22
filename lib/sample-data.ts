// Seed data for the in-memory store (used when Supabase is not configured).
// These run through the same extraction + scoring + schedule pipeline as real
// input, so the app is populated and fully explorable on first load.

import type { EntryKind, Project } from "./types";

export interface SampleEntry {
  notes: string;
  createdAt: string;
  kind: EntryKind;
  area: string;
  projectId: string;
}

const ANALYTICS_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PIANO_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

export const SAMPLE_PROJECTS: Project[] = [
  {
    id: ANALYTICS_PROJECT_ID,
    name: "Q2 Analytics Initiative",
    description: "Dashboard delivery and the supporting mobile launch work.",
    deadline: "2026-05-29",
    created_at: "2026-05-15T09:00:00.000Z",
  },
  {
    id: PIANO_PROJECT_ID,
    name: "Learning Piano",
    description: "A personal goal to pick up the basics of piano.",
    deadline: null,
    created_at: "2026-05-17T17:30:00.000Z",
  },
];

export const SAMPLE_ENTRIES: SampleEntry[] = [
  {
    createdAt: "2026-05-16T09:00:00.000Z",
    kind: "meeting",
    area: "Work",
    projectId: ANALYTICS_PROJECT_ID,
    notes: `Q2 Analytics Dashboard Kickoff
We need to present dashboard insights to stakeholders by Friday.
Let's use monthly revenue as the main performance metric.
Abi will clean the customer dataset before Friday's review.
Sarah will confirm the final KPI definition with the leadership team.
Priya needs to build the dashboard draft once the dataset is ready.
We should review the dashboard draft with stakeholders next week.
The missing region values are unclear and need to be resolved.
Who will sign off on the final stakeholder presentation?
We are assuming monthly revenue is the primary KPI for this quarter.`,
  },
  {
    createdAt: "2026-05-17T08:30:00.000Z",
    kind: "meeting",
    area: "Work",
    projectId: ANALYTICS_PROJECT_ID,
    notes: `Mobile App Launch Standup
We decided to ship the public beta on May 22.
Daniel will fix the login crash on Android today.
Maria needs to write the release notes before the launch.
The QA team should test the full payment flow this week.
We must update the App Store screenshots tomorrow.
It is unclear whether the analytics SDK is approved by legal.
Who will own the rollout communication to existing users?
We are assuming the staging environment mirrors production.`,
  },
  {
    createdAt: "2026-05-17T18:00:00.000Z",
    kind: "plan",
    area: "Hobby",
    projectId: PIANO_PROJECT_ID,
    notes: `I want to learn the basics of piano this week.`,
  },
];
