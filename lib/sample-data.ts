// Seed data for the in-memory store (used when Supabase is not configured).
// These run through the same extraction + scoring + schedule pipeline as real
// input, so the app is populated and fully explorable on first load.

import type {
  ActivityCompletion,
  EntryKind,
  Project,
  RecurringActivity,
} from "./types";

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

// --- Recurring activities (routines & goals) --------------------------------

const QURAN_ACTIVITY_ID = "33333333-3333-4333-8333-333333333333";
const PIANO_PRACTICE_ID = "44444444-4444-4444-8444-444444444444";
const WORKOUT_ACTIVITY_ID = "55555555-5555-4555-8555-555555555555";

export const SAMPLE_ACTIVITIES: RecurringActivity[] = [
  {
    id: QURAN_ACTIVITY_ID,
    title: "Read Quran",
    area: "Personal",
    period: "day",
    target_count: 1,
    weekdays: null,
    estimated_minutes: 15,
    urgency: 3,
    impact: 4,
    effort: 1,
    dependency: 1,
    risk: 2,
    confidence: 5,
    protected: true, // a streak habit — shielded by default
    active: true,
    created_at: "2026-05-15T07:00:00.000Z",
  },
  {
    id: PIANO_PRACTICE_ID,
    title: "Piano practice",
    area: "Hobby",
    period: "week",
    target_count: 3,
    weekdays: null,
    estimated_minutes: 30,
    urgency: 2,
    impact: 3,
    effort: 3,
    dependency: 1,
    risk: 2,
    confidence: 4,
    protected: false, // a discretionary goal — the first flex to sacrifice
    active: true,
    created_at: "2026-05-17T18:30:00.000Z",
  },
  {
    id: WORKOUT_ACTIVITY_ID,
    title: "Workout",
    area: "Personal",
    period: "day",
    target_count: 1,
    weekdays: [1, 2, 3, 4, 5], // weekdays only
    estimated_minutes: 45,
    urgency: 2,
    impact: 4,
    effort: 4,
    dependency: 1,
    risk: 2,
    confidence: 3,
    protected: false,
    active: true,
    created_at: "2026-05-18T06:30:00.000Z",
  },
];

/** ISO date `days` before `today` (UTC-stable). */
function isoDaysAgo(today: string, days: number): string {
  const [y, m, d] = today.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Seed completions relative to `today` so streaks/progress render non-empty on
 * first load (the in-memory demo computes status against the live date). Quran
 * has a few consecutive prior days (a live streak, still due today); piano has
 * one logged session this week (1 of 3); workout one recent day.
 */
export function sampleActivityCompletions(today: string): ActivityCompletion[] {
  const make = (
    activity_id: string,
    daysAgo: number,
    minutes: number,
  ): ActivityCompletion => ({
    id: crypto.randomUUID(),
    activity_id,
    date: isoDaysAgo(today, daysAgo),
    minutes,
    skipped: false,
    created_at: new Date().toISOString(),
  });
  return [
    make(QURAN_ACTIVITY_ID, 1, 15),
    make(QURAN_ACTIVITY_ID, 2, 15),
    make(QURAN_ACTIVITY_ID, 3, 15),
    make(QURAN_ACTIVITY_ID, 4, 15),
    make(PIANO_PRACTICE_ID, 1, 30),
    make(WORKOUT_ACTIVITY_ID, 1, 45),
  ];
}
