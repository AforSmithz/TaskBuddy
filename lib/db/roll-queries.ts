import "server-only";
import { isDbConfigured, withoutUser } from "@/lib/db/pool";

// The one query the scheduled plan roll needs that no user can make.
//
// Kept out of store.ts on purpose. Everything in there resolves through the shim, which refuses
// to run without a session - correct for all ~200 of its call sites and exactly wrong for this
// one, since the whole point is that there is no session. Kept out of auth-queries.ts too: that
// module is scoped to the sign-in path, and a roll is not authentication.
//
// Mirrors auth-queries.ts's shape deliberately - withoutUser + a SECURITY DEFINER function in
// the `app` schema - because that is the only sanctioned way past RLS in this codebase and it
// should look the same everywhere it happens.

/** Every account id, for the daily roll's fan-out. See aws/sql/07_plan_roll.sql.
 *
 *  This is the ONE cross-tenant read in the application, and it returns uuids only: no email, no
 *  name, nothing that would make a leak interesting. The ids are immediately handed back to
 *  runAsUser(), so all the work the roll then does runs under the ordinary policies.
 *
 *  Empty rather than throwing when there is no database, so local dev and the demo path get a
 *  fan-out over nobody instead of a crash. */
export async function listAllUserIds(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  return withoutUser(async (client) => {
    const res = await client.query<{ id: string }>("select id from app.all_user_ids()");
    return res.rows.map((r) => r.id);
  });
}
