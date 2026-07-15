# TaskBuddy

An adaptive goal-planning app. You state a goal, TaskBuddy breaks it into tasks,
schedules everything into one timeline across all your goals, and tells you the
probability you actually finish on time. When reality diverges from the plan, it
proposes a recovery strategy instead of quietly going red.

> **Design philosophy:** the LLM is used for *understanding* (turning messy notes
> into structured tasks, reading a written check-in). Every number, the priority
> score, the schedule, the completion odds, the recommended move, comes from
> deterministic code you can read. No probability is ever produced by a model.

## Stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Azure Database
for PostgreSQL, self-hosted session auth, Microsoft Foundry for the LLM layer.
Deployed on Vercel.

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

With no environment configured, the app runs in demo mode: an in-memory store
seeded with sample data, and an offline heuristic parser instead of the LLM.
Everything works, but data resets when the server restarts. The sidebar shows a
"Demo mode" badge while keys are missing.

## Going live

Copy `.env.local.example` to `.env.local` and fill it in. That file documents
every variable and the reasoning behind it; the short version:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Azure Postgres, as the `taskbuddy_app` role. Unset means demo mode. |
| `SESSION_SECRET` | Signing key for the session cookie. Minimum 32 bytes. |
| `SIGNUP_CODE` | Required to create an account. There is no email verification. |
| `AZURE_FOUNDRY_ENDPOINT` / `AZURE_FOUNDRY_API_KEY` | LLM extraction. Unset means the heuristic extractor. |

Apply the schema with `azure/apply-sql.sh`, which runs `azure/sql/01_schema.sql`,
`02_grants.sql` and `03_auth.sql` in order and then verifies them.

Each layer degrades on its own. No database means the in-memory store; no
Foundry credentials means the heuristic extractor; a failed LLM call falls back
to the heuristic rather than erroring the request.

## Architecture

```
notes or goal -> extraction -> priority scoring -> allocation -> forecast -> strategy
```

| Layer | What it does | Where |
| --- | --- | --- |
| Extraction | Notes into structured tasks, via LLM or offline heuristic | `lib/extraction.ts`, `lib/heuristic.ts` |
| Priority | Deterministic six-factor score | `lib/priority.ts` |
| Scheduling | Dependency ordering, day packing, within-day arrangement | `lib/schedule.ts`, `lib/allocate.ts`, `lib/arrange.ts` |
| Forecast | Monte Carlo completion probability against real availability | `lib/forecast.ts` |
| Strategy | Cross-goal recovery moves when the odds drop | `lib/portfolio-strategist.ts`, `lib/strategist.ts` |
| Data | Query layer over node-postgres, with an in-memory fallback | `lib/store.ts`, `lib/db/` |
| Auth | bcrypt passwords, signed session cookies, RLS per request | `lib/auth.ts`, `lib/session.ts`, `lib/password.ts` |
| LLM client | Foundry calls with strict JSON schemas | `lib/foundry.ts` |
| Mutations | Server Actions | `lib/actions.ts` |

**Priority score** = `Urgency*0.30 + Impact*0.25 + Dependency*0.20 + Risk*0.15 +
Confidence*0.10 - Effort*0.10`, mapped to Critical / High / Medium / Low /
Backlog bands.

Every row is read through Postgres row-level security. The app connects as an
unprivileged role and sets the current user id per transaction, so a query
cannot return another account's data even if the application logic is wrong.

## Routes

| Route | What it is |
| --- | --- |
| `/` | Today: agenda, time budget, completion odds, current strategy |
| `/strategy` | Cross-goal strategy, recovery moves, plan history |
| `/board` | Kanban board across every goal |
| `/projects` | Goals, each with its own forecast |
| `/activities` | Routines and recurring commitments |
| `/create` | New entry, paste notes or state a goal |
| `/settings` | Value model, availability, weekly capacity |
| `/login`, `/signup` | Self-hosted email and password auth |

## Infrastructure

The whole Azure stack is defined as Bicep in `azure/infra/`. Always run
`az deployment group what-if` before applying: several properties on the
Postgres server are cost controls sitting exactly on the free-tier edge, and
changing `storageSizeGB`, `autoGrow`, `skuName`, `highAvailability` or
`geoRedundantBackup` moves the server off $0/mo. A GitHub Actions workflow posts
that what-if plan on any PR touching infrastructure, authenticating through OIDC
federation with a `Reader` role, so CI can show the blast radius without holding
credentials that could change anything.

On Vercel the app authenticates to Foundry with a federated workload identity
exchanged from a per-invocation OIDC assertion, so no long-lived Azure secret is
stored in the deployment.

Two region constraints worth knowing before provisioning. The subscription's
`sys.regionrestriction` policy allows only `japanwest`, `centralindia`,
`indonesiacentral`, `koreacentral` and `eastasia`, and a disallowed region fails
*after* the CLI prints "Creating PostgreSQL Server", so it reads as a transient
error. Postgres sits in `eastasia` paired with Vercel's `hkg1` because the db
layer runs a transaction per statement and latency dominates. Foundry cannot sit
beside it: `eastasia` has zero model quota, so it runs in `koreacentral`.

## Scripts

```bash
pnpm dev      # development server
pnpm build    # production build
pnpm start    # serve the production build
pnpm lint     # ESLint
```
