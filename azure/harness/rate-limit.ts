/**
 * Offline harness for the login/signup rate limiter.
 *
 *   npx tsx azure/harness/rate-limit.ts
 *
 * No database, no network, no Next runtime. `lib/rate-limit.ts` keeps its
 * window accounting in a pure `consume(key, limit, now)` with the clock
 * injected, so the whole thing is exercisable here — same split as
 * lib/db/query.ts vs shim.ts, and for the same reason.
 *
 * What this is actually checking: that a control which sits in front of a
 * ~290ms bcrypt on an unauthenticated endpoint both (a) lets real users
 * through and (b) actually stops at the limit. A limiter that never fires is
 * worse than none, because it reads like protection.
 */
import {
  consume,
  __resetWindows,
  __windowCount,
  __MAX_KEYS,
} from "../../lib/rate-limit";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

const T0 = 1_000_000;
const MINUTE = 60_000;

// --- the limit itself -------------------------------------------------------
__resetWindows();
{
  const blocked: boolean[] = [];
  for (let i = 0; i < 12; i++) blocked.push(consume("login:1.1.1.1", 10, T0));

  ok("first 10 attempts pass", blocked.slice(0, 10).every((b) => !b));
  ok("the 11th is blocked", blocked[10] === true);
  ok("and it stays blocked", blocked[11] === true);
}

// --- the window rolls -------------------------------------------------------
__resetWindows();
{
  for (let i = 0; i < 11; i++) consume("login:2.2.2.2", 10, T0);
  ok("still blocked at 59s", consume("login:2.2.2.2", 10, T0 + 59_000) === true);
  ok(
    "allowed again once the window rolls",
    consume("login:2.2.2.2", 10, T0 + MINUTE) === false,
  );
}

// --- callers do not share a bucket -----------------------------------------
__resetWindows();
{
  for (let i = 0; i < 11; i++) consume("login:3.3.3.3", 10, T0);
  ok(
    "a different client is unaffected",
    consume("login:4.4.4.4", 10, T0) === false,
  );
  ok(
    "a different bucket for the same client is unaffected",
    consume("signup:3.3.3.3", 5, T0) === false,
  );
}

// --- signup's stricter limit ------------------------------------------------
__resetWindows();
{
  const blocked: boolean[] = [];
  for (let i = 0; i < 7; i++) blocked.push(consume("signup:5.5.5.5", 5, T0));
  ok("first 5 signups pass", blocked.slice(0, 5).every((b) => !b));
  ok("the 6th is blocked", blocked[5] === true);
}

// --- memory does not grow without bound -------------------------------------
// The failure this guards against: a spray across many source addresses turning
// the limiter itself into unbounded allocation on a 1 vCore instance.
__resetWindows();
{
  for (let i = 0; i < 6_000; i++) {
    consume(`login:10.0.${i >> 8}.${i & 255}`, 10, T0);
  }
  ok(
    `6000 distinct clients stay capped at ${__MAX_KEYS} (was ${__windowCount()})`,
    __windowCount() <= __MAX_KEYS,
  );

  // Everything above shares one timestamp, so one write past the window must
  // sweep the lot rather than letting them accumulate.
  consume("login:new-client", 10, T0 + 2 * MINUTE);
  ok(
    `stale entries are swept on the next write (${__windowCount()} left)`,
    __windowCount() === 1,
  );
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
