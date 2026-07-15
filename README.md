# TaskBuddy

An AI-powered **meeting-to-execution dashboard**. Paste messy meeting notes and
TaskBuddy turns them into a structured plan: summary, decisions, open questions,
blockers, prioritised tasks, a recommended schedule, and a Kanban workflow.

> **Design philosophy:** the LLM is used for _understanding_ (extraction,
> summaries, follow-up messages). Prioritisation and scheduling use
> **transparent, deterministic formulas** — so the workflow is explainable.

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

### Demo mode (no setup required)

Out of the box TaskBuddy runs in **demo mode**:

- **Data** is stored in an in-memory store, seeded with two sample meetings.
- **Extraction** uses an offline heuristic parser instead of an LLM.

Everything works — create meetings, score tasks, build schedules, use the
Kanban board — but data resets when the server restarts. The sidebar shows a
"Demo mode" badge while keys are missing.

## Going live

Add a `.env.local` file (copy `.env.local.example`) and fill in:

### 1. Supabase (persistent storage)

1. Create a project at <https://supabase.com>.
2. In the SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql).
3. From **Project Settings → API**, copy into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only — never exposed to the browser)

### 2. Microsoft Foundry (LLM extraction)

1. Provision the Foundry resource and its two model deployments — the exact
   `az` commands are in `azure/FOUNDRY.md` §6.
2. Set `AZURE_FOUNDRY_ENDPOINT` and `AZURE_FOUNDRY_API_KEY`.

Once both are present, TaskBuddy switches that layer over automatically — no
code change. If an LLM call fails, it falls back to the heuristic extractor.

The primary deployment is `gpt-5-mini` and the fallback is `gpt-4.1-mini`, both
in `koreacentral`. That region is not a preference: `eastasia`, where the
database lives, has zero model quota on this subscription.

## How it works

```
Paste notes → LLM/heuristic extraction → deterministic scoring → schedule → Kanban
```

| Layer            | Powered by        | Files                                  |
| ---------------- | ----------------- | -------------------------------------- |
| Extraction       | LLM or heuristic  | `lib/extraction.ts`, `lib/heuristic.ts`|
| Priority scoring | Deterministic     | `lib/priority.ts`                      |
| Scheduling       | Deterministic     | `lib/schedule.ts`                      |
| Data layer       | Supabase / memory | `lib/store.ts`                         |
| Mutations        | Server Actions    | `lib/actions.ts`                       |

**Priority score** = `Urgency·0.30 + Impact·0.25 + Dependency·0.20 +
Risk·0.15 + Confidence·0.10 − Effort·0.10`, mapped to Critical / High / Medium /
Low / Backlog bands.

## Routes

- `/` — workload dashboard, recommended next task, end-of-day summary
- `/meetings/new` — paste meeting notes
- `/meetings/[id]` — summary, decisions, questions, tasks, schedule, planner
- `/board` — global Kanban board (drag or use the status menu)

## Scripts

```bash
pnpm dev      # development server
pnpm build    # production build
pnpm start    # serve the production build
pnpm lint     # ESLint
```

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
lucide-react · Azure PostgreSQL · Microsoft Foundry.
