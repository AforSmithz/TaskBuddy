-- Signed session assumption: makes app.uid() unforgeable by the app role.
--
-- Run as the cluster master, AFTER 01_schema.sql and 02_grants.sql.
--
--   psql -v session_key="$TASKBUDDY_SESSION_MAC_KEY" -f 06_session_mac.sql
--
-- ===========================================================================
-- WHAT THIS FIXES
-- ===========================================================================
--
-- Until this file, every RLS policy in 01_schema.sql resolved through
-- app.uid(), which read the `app.user_id` GUC and trusted it:
--
--     select nullif(current_setting('app.user_id', true), '')::uuid
--
-- A GUC is settable by whoever holds the connection. So anyone who could
-- authenticate as taskbuddy_app could run
--
--     select set_config('app.user_id', '<any uuid>', true);
--
-- and read every row in the database. RLS was therefore a defence against an
-- APPLICATION BUG - a query that forgot its owner filter - and nothing else.
-- It was NOT a defence against someone holding a database connection, which is
-- the case the network posture actually needs covered: the cluster is publicly
-- routable on 5432 (see data-stack.ts) precisely because IAM auth, forced TLS
-- and RLS were judged sufficient compensating controls. Two of those three were
-- real. This file makes the third one real too.
--
-- THREAT MODEL. The attacker this closes out holds an IAM principal in the
-- account that can call rds-db:connect as taskbuddy_app - a leaked CI role, an
-- over-broad policy, an exfiltrated credential - but does NOT have code
-- execution inside the Lambda. Anyone who owns the function already owns its
-- environment, and no database-side control can help with that. The point is to
-- stop the two from being the same thing, which is what "the SG is open but RLS
-- protects us" was quietly assuming.
--
-- HOW. The GUC stops carrying a bare uuid and starts carrying
--
--     <uuid>.<expires-unix-seconds>.<hmac-sha256 hex>
--
-- keyed on a secret held in app.session_key, which taskbuddy_app cannot read.
-- app.uid() verifies before returning. Forging an identity now costs the key,
-- and the key is only ever in two places: this table (owner-only) and the
-- Lambda's environment (see lib/db/session-mac.ts).
--
-- WHY VERIFY ON READ rather than gate the write. The obvious design is an
-- app.assume(uid, mac) function that checks the MAC and then sets the GUC. It
-- does not work: nothing stops the caller skipping it and calling set_config
-- directly, and a custom placeholder GUC has no ACL to revoke. Verification has
-- to happen where the value is CONSUMED, which is here.
-- ===========================================================================

-- pgcrypto is OPTIONAL in 01_schema.sql (it only wanted gen_random_uuid, which
-- is core since PG13) and REQUIRED here. Stated as its own statement so a
-- cluster without it fails on this line with the extension name in the error,
-- rather than 40 lines later on "function public.hmac(...) does not exist".
create extension if not exists "pgcrypto" with schema public;

-- The cast is the point. pgcrypto ships hmac(bytea,bytea,text) and
-- hmac(text,text,text) and nothing in between, so a text message with a bytea key
-- - which is exactly what app.uid() has - resolves to neither. Probing with a bare
-- 'probe' literal would NOT catch that: an unknown-type literal coerces happily to
-- bytea and the probe passes while the real call fails.
do $$
begin
  perform public.hmac(convert_to('probe'::text, 'UTF8'), '\x00'::bytea, 'sha256');
exception when undefined_function then
  raise exception
    'public.hmac() is missing. pgcrypto is required by this file and must live '
    'in schema public - app.uid() runs with an empty search_path and qualifies '
    'it as public.hmac. If pgcrypto was installed elsewhere, move it: '
    'ALTER EXTENSION pgcrypto SET SCHEMA public;';
end
$$;

-- ---------------------------------------------------------------------------
-- The key.
--
-- Several rows are allowed, and that IS the rotation mechanism: a signature
-- matching ANY row verifies. Rotating is therefore (1) insert the new key,
-- (2) deploy the app with it, (3) delete the old row - with no window in which
-- signatures made by the running app stop verifying.
--
-- bytea, not text. The app holds the same key as hex (openssl rand -hex 32) and
-- HMACs over the decoded bytes; storing the hex string instead would key the
-- MAC on 64 ASCII characters while Node keyed it on 32 bytes, and every
-- signature would fail with both sides looking correct.
-- ---------------------------------------------------------------------------
create table if not exists app.session_key (
  id         smallint primary key,
  secret     bytea not null,
  created_at timestamptz not null default now(),
  constraint session_key_length check (octet_length(secret) >= 32)
);

comment on table app.session_key is
  'HMAC keys for app.uid() session verification. Readable only by the owner; taskbuddy_app must never hold SELECT here.';

-- Belt and braces. 02_grants.sql only grants on schema public, so nothing
-- should have reached this table - but a future blanket grant written against
-- `all tables in schema app` would silently hand the app role the key and
-- restore the exact hole this file closes.
revoke all on app.session_key from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'taskbuddy_app') then
    execute 'revoke all on app.session_key from taskbuddy_app';
  end if;
end
$$;

-- Seeded from the same value the Lambdas get as DB_SESSION_KEY. id 1 is the
-- current key; `on conflict do update` so re-running this file with a rotated
-- value is the rotation, not an error.
insert into app.session_key (id, secret)
values (1, decode(:'session_key', 'hex'))
on conflict (id) do update set secret = excluded.secret, created_at = now();

-- ---------------------------------------------------------------------------
-- app.uid(), replacing the version in 01_schema.sql.
--
-- IF YOU RE-RUN 01_schema.sql, RE-RUN THIS FILE AFTERWARDS. 01 recreates
-- app.uid() as the unverified version, and nothing errors - the app keeps
-- working, because it sets both GUCs during the transition, and the control
-- just quietly stops being there. Same hazard, and same remedy, as the
-- 02 -> 03 ordering note in 02_grants.sql.
--
-- Contract is unchanged where it matters: returns the current user id, or NULL
-- when there is no valid session. NULL denies every policy, so an absent,
-- malformed, expired or forged value all fail closed. Callers cannot tell those
-- apart, deliberately - a policy check is not an error channel.
--
-- STABLE, and it must stay STABLE: 01_schema.sql wraps every policy call as
-- `(select app.uid())` so the planner runs it as a one-per-statement InitPlan
-- rather than once per row. That wrapping was a performance nicety when this
-- was a GUC read. It is now load-bearing - this body does an HMAC.
--
-- SECURITY DEFINER because taskbuddy_app cannot read app.session_key and must
-- not be able to. search_path is empty and every non-catalog reference is
-- schema-qualified, so nothing on the caller's path can be substituted for
-- public.hmac.
-- ---------------------------------------------------------------------------
create or replace function app.uid() returns uuid
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
declare
  raw   text;
  parts text[];
  msg   text;
  sig   bytea;
begin
  raw := nullif(current_setting('app.session', true), '');
  if raw is null then
    return null;
  end if;

  -- Shape-check before any cast. The alternative is a begin/exception block
  -- around ::uuid and ::bigint, which opens a subtransaction on every statement
  -- in the application. This pattern guarantees both casts below succeed, so
  -- there is nothing to catch.
  if raw !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[0-9]{1,20}\.[0-9a-f]{64}$' then
    return null;
  end if;

  parts := string_to_array(raw, '.');
  msg   := parts[1] || '.' || parts[2];
  sig   := decode(parts[3], 'hex');
  -- convert_to(..., 'UTF8') below, not a cast: there is no text -> bytea cast in
  -- PostgreSQL, and it also states the encoding explicitly rather than inheriting
  -- the database's. Node's createHmac().update(string) defaults to utf8, so the two
  -- sides hash the same bytes. If they ever stop agreeing, this line is why.

  -- now(), not clock_timestamp(): transaction time. The GUC is set in the same
  -- round trip as BEGIN, so this is the clock the signature was made against,
  -- and it keeps the function honestly STABLE.
  if parts[2]::bigint < extract(epoch from now()) then
    return null;
  end if;

  -- Double HMAC rather than a direct byte comparison. bytea `=` is a memcmp and
  -- short-circuits on the first differing byte, which is a timing oracle on a
  -- value the attacker is trying to guess. Re-keying both sides makes the
  -- compared operands unpredictable to them, so the leak carries no signal.
  -- Three HMACs of a 60-byte message is single-digit microseconds; the InitPlan
  -- means it is paid once per statement, not once per row.
  if not exists (
    select 1
      from app.session_key k
     where public.hmac(public.hmac(convert_to(msg, 'UTF8'), k.secret, 'sha256'), k.secret, 'sha256')
         = public.hmac(sig, k.secret, 'sha256')
  ) then
    return null;
  end if;

  return parts[1]::uuid;
end
$$;

comment on function app.uid() is
  'Current user id for RLS, from the signed app.session GUC (uuid.expires.hmac). NULL when absent, malformed, expired or forged - all of which deny every policy.';

-- taskbuddy_app already holds EXECUTE from 02_grants.sql; restated because
-- CREATE OR REPLACE on a function whose signature is unchanged keeps existing
-- grants, but a future signature change would drop them silently.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'taskbuddy_app') then
    execute 'grant execute on function app.uid() to taskbuddy_app';
  end if;
end
$$;

-- ===========================================================================
-- Verification. Every check below RAISES rather than returning a row: a
-- printed result only helps if someone reads it, and this file exists because
-- a control that silently is not there is worse than one that was never
-- claimed.
-- ===========================================================================

-- 1. A key is present and app.uid() actually verifies. Signs a probe in SQL the
--    same way lib/db/session-mac.ts does in Node, and asserts round-trip.
do $$
declare
  probe_uid  constant uuid := '00000000-0000-4000-8000-000000000001';
  expires    bigint := (extract(epoch from now()) + 300)::bigint;
  msg        text;
  mac        text;
  got        uuid;
begin
  msg := probe_uid::text || '.' || expires::text;
  select encode(public.hmac(convert_to(msg, 'UTF8'), k.secret, 'sha256'), 'hex') into mac
    from app.session_key k where k.id = 1;
  if mac is null then
    raise exception 'app.session_key has no id=1 row; the -v session_key psql variable was empty.';
  end if;

  perform set_config('app.session', msg || '.' || mac, true);
  got := app.uid();
  if got is distinct from probe_uid then
    raise exception 'app.uid() rejected a correctly signed session (got %). The key in the table and the key the app holds must be the same hex string.', got;
  end if;

  -- 2. A forged session is rejected. This is the whole file in one assertion:
  --    the bare-uuid form that used to work must not work any more.
  perform set_config('app.session', probe_uid::text, true);
  if app.uid() is not null then
    raise exception 'app.uid() accepted an UNSIGNED session. The verifying definition did not take.';
  end if;

  perform set_config('app.session', msg || '.' || repeat('0', 64), true);
  if app.uid() is not null then
    raise exception 'app.uid() accepted a session with a wrong MAC.';
  end if;

  -- 3. An expired signature is rejected, so a value scraped from a slow-query
  --    log is not a permanent credential.
  expires := (extract(epoch from now()) - 1)::bigint;
  msg := probe_uid::text || '.' || expires::text;
  select encode(public.hmac(convert_to(msg, 'UTF8'), k.secret, 'sha256'), 'hex') into mac
    from app.session_key k where k.id = 1;
  perform set_config('app.session', msg || '.' || mac, true);
  if app.uid() is not null then
    raise exception 'app.uid() accepted an EXPIRED session.';
  end if;

  perform set_config('app.session', '', true);
  raise notice 'ok: app.uid() verifies signed sessions and rejects unsigned, mis-signed and expired ones';
end
$$;

-- 4. The app role cannot read the key. If this ever stops raising, the control
--    is decorative: taskbuddy_app could read the secret and sign anything.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'taskbuddy_app') then
    raise notice 'skipped: taskbuddy_app does not exist yet (run 02_grants.sql first)';
    return;
  end if;
  if has_table_privilege('taskbuddy_app', 'app.session_key', 'select') then
    raise exception
      'taskbuddy_app can SELECT app.session_key. It could read the signing key '
      'and forge any identity, which defeats this entire file. Revoke it.';
  end if;
  if not has_function_privilege('taskbuddy_app', 'app.uid()', 'execute') then
    raise exception 'taskbuddy_app cannot EXECUTE app.uid(); every policy would error.';
  end if;
  raise notice 'ok: taskbuddy_app can call app.uid() and cannot read the key behind it';
end
$$;
