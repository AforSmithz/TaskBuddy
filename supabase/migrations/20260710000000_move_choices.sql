-- Offered-vs-kept move signal (OVERHAUL §8 "cause→move-ordering hardening", limitation #3).
--
-- `prefFor` in optimizeJointPlan sums two tiebreak nudges:
--     STYLE_PREF_WEIGHT * movePref(style, kind) + CAUSE_PREF_WEIGHT * causeMovePref(cause, kind)
-- and the 1:1 ratio was an unexamined assumption. The step-5 plan parameterized it into
-- two constants and deferred the ratio to "calibrate from live data via S2's loop" — but
-- nothing recorded the data. `plan_versions.moves` holds only the COMMITTED bundle, so the
-- moves the strategist offered and the user DECLINED were never written down, and a
-- revealed preference needs both halves.
--
-- This table is that missing signal, and a SIBLING to plan_reorders (which plays the same
-- role for the arrangement weights): dispose-side bookkeeping only, authors no odds. When
-- the user applies a strategist bundle we keep every move that was on the table plus
-- whether it survived the checkboxes. `calibrateMovePrefWeights` recomputes the feature
-- vector φ from the LIVE preference tables over these rows (single source of truth — a
-- table edit re-prices history, the same choice plan_reorders made) and nudges the two
-- weights via the shared EB seam in lib/calibrate.ts.
--
-- Only the STRATEGIST's review surface writes here. The §5.6 check-in review also commits
-- bundles, but its moves are user-asserted facts ("I finished X") carrying no diagnosed
-- cause — unchecking a spillover row reveals nothing about recovery taste, so recording it
-- would feed the perceptron noise.
--
-- `recovery_style` is stored rather than read live: it is an INPUT to φ, not a feature
-- function, and the offer was made under the style in force at the time. Same reason the
-- per-goal cause is stored on each move. (The preference TABLES are read live.)
create table if not exists move_choices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  captured_at    timestamptz not null default now(),  -- when the bundle was applied
  recovery_style text not null,                        -- ValueModel.recoveryStyle at offer time
  offered        jsonb not null,                       -- OfferedMove[] — kind + projectId + causes + kept
  schema_version integer not null                      -- MOVE_CHOICE_SCHEMA_VERSION — drop a stale shape
);

create index if not exists move_choices_user_captured_idx
  on move_choices (user_id, captured_at desc);

alter table move_choices enable row level security;
drop policy if exists move_choices_owner on move_choices;
create policy move_choices_owner on move_choices
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
