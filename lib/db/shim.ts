import "server-only";
import { cookies } from "next/headers";
import { QueryBuilder, type Executor, type Row } from "./query";
import { withUser } from "./pool";
import { SESSION_COOKIE, verifySession } from "../session";

// The request-scoped database handle. All the query-building logic lives in
// `./query.ts`; this file is only the seam that binds a builder to the signed-in
// user and a real connection.

export interface RequestClient {
  from(table: string): QueryBuilder;
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: null;
    }>;
  };
}

/**
 * One statement, one transaction, `app.user_id` set for the duration.
 *
 * Per statement rather than per request, and that is mandatory rather than a
 * tuning choice. RLS cannot be replaced by injecting `WHERE user_id = $uid`:
 * seven tables (`decisions`, `open_questions`, `tasks`, `task_dependencies`,
 * `goal_criteria`, `skill_nodes`, `skill_task_links`) have no `user_id` column
 * at all and are scoped by EXISTS-subquery policies through a parent foreign
 * key. Filter injection would either error on a missing column or skip the
 * filter and read across tenants.
 */
function executorFor(uid: string): Executor {
  return (text, values) =>
    withUser(uid, async (client) => {
      const res = await client.query(text, values);
      return res.rows as Row[];
    });
}

/**
 * The per-request database handle. Same name, same module position and same
 * async signature as the Supabase original, so `lib/store.ts`'s
 * `type RequestClient = Awaited<ReturnType<typeof getRequestClient>>` and the
 * four sites that pass the client as a parameter are untouched.
 *
 * The user id is resolved EAGERLY, here, rather than lazily inside
 * `auth.getUser()`. Only write paths call `currentUserId()`; every read calls
 * `.from()` with no id in hand, and each of those statements still needs
 * `app.user_id` set. Resolving once per client also keeps `currentUserId` —
 * which runs on every write — from re-verifying the token each time.
 */
export async function getRequestClient(): Promise<RequestClient> {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  const uid = claims?.sub ?? null;
  const exec = uid ? executorFor(uid) : null;

  return {
    from: (table: string) => new QueryBuilder(table, exec),
    auth: {
      getUser: async () => ({
        data: { user: uid ? { id: uid } : null },
        error: null,
      }),
    },
  };
}
