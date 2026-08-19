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

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Amazon Aurora
PostgreSQL Serverless v2, Amazon Cognito for auth, Amazon Bedrock for the LLM
layer. Runs on AWS Lambda behind CloudFront, with the async half on EventBridge,
SQS and Step Functions.

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
| `PGHOST` | Aurora writer endpoint. The app connects as `taskbuddy_app` with an IAM token; there is no password. Unset means demo mode. |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | Auth. Neither is a secret, and the client secret is never stored: it is read at cold start. |
| `SIGNUP_CODE` | Required to create an account. There is no email verification. |
| `BEDROCK_MODEL` | Inference profile id. Unset falls back to a documented default. |

Note what is *not* on that list: no database password, no API key, and no
`SESSION_SECRET`. Every credential is either an IAM token derived from the
execution role or a public identifier.

Apply the schema with `aws/scripts/apply-sql.sh`, which runs `aws/sql/01_schema.sql`
through `04_cognito.sql` in order and then verifies them.

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
| Auth | Cognito user pool, verified ID tokens, RLS per request | `lib/auth.ts`, `lib/session.ts`, `lib/cognito.ts` |
| LLM client | Bedrock Converse with strict JSON schemas | `lib/bedrock.ts` |
| Mutations | Server Actions | `lib/actions.ts` |
| Async jobs | Job bodies shared by actions and SQS workers | `lib/job-handlers.ts`, `lib/jobs.ts` |

**Priority score** = `Urgency*0.30 + Impact*0.25 + Dependency*0.20 + Risk*0.15 +
Confidence*0.10 - Effort*0.10`, mapped to Critical / High / Medium / Low /
Backlog bands.

Every row is read through Postgres row-level security. The app connects as an
unprivileged role and sets the current user id per transaction, so a query
cannot return another account's data even if the application logic is wrong.

Cognito mints its own subject id, so it is deliberately not the app's user id.
The Postgres `users.id` travels in the ID token as `custom:app_uid`, which is
what lets every foreign key and every policy stay exactly as it was, and what
keeps "who is this?" free of a database round trip.

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

The whole AWS stack is defined as CDK in `aws/infra/` - six stacks: `data`,
`auth`, `events`, `web`, `observability`, and `edge`. Always run `cdk diff`
before applying.

Three properties are cost controls sitting on an exact edge, and each one reads
like an ops choice:

- **`DB_MIN_ACU = 0`** is what lets Aurora auto-pause. Setting it to `0.5` reads
  like "always keep a little capacity" and takes the cluster from about $10/mo
  to about $50/mo with no other change and no warning.
- **`idleTimeoutMillis: 10_000`** in `lib/db/pool.ts` is no longer just hygiene.
  Aurora will not pause while any connection is open, so a pool that held
  connections between page views would keep capacity awake around the clock.
- **No NAT gateway.** One would cost more per month than everything else in the
  architecture combined. That is why Lambda is not VPC-attached and why the
  cluster is publicly routable - a trade paid for with IAM-only authentication,
  forced TLS against a pinned regional CA, and forced RLS.

Two `cdk synth` warnings (`W2508`, `W9011`) are expected on every run and are
documented in `aws/README.md`; they cannot be suppressed, and if either ever
stops appearing the network posture changed.

Long LLM work does not run in a request. Eleven call sites, seven at medium
reasoning effort and one measured at 43 seconds, are moved behind an EventBridge
bus into an SQS queue with a DLQ and a concurrency cap; the skill-link fan-out
runs through a Step Functions Distributed Map so a throttled judgement retries
instead of being silently dropped.

Everything sits in `ap-southeast-1`, about 30ms from Jakarta. one region covers the whole stack.

## Scripts

```bash
pnpm dev      # development server
pnpm build    # production build
pnpm start    # serve the production build
pnpm lint     # ESLint
```

```bash
npx tsx aws/harness/offline.ts              # 26 offline assertions, no network
bash aws/scripts/preflight.sh               # is this account ready to deploy?
bash aws/scripts/build-web.sh               # assemble the Lambda bundle
TASKBUDDY_ALERT_EMAIL=... bash aws/scripts/deploy.sh
```
