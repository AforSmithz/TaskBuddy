import "server-only";
import { QueryBuilder, type Executor, type Row } from "./query";
import { withUser } from "./pool";
import { ambientUserId } from "./context";

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
 * A client bound to an explicit user id.
 *
 * This is the seam the SQS workers enter through. They have a job payload
 * rather than a cookie, so they establish the user with
 * `runAsUser(uid, ...)` from ./context and everything downstream - all ~200
 * `getRequestClient()` calls in lib/store.ts - resolves through it unchanged.
 */
export function requestClientFor(uid: string | null): RequestClient {
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

/**
 * The per-request database handle. Same name, same module position and same
 * async signature as the Supabase original, so `lib/store.ts`'s
 * `type RequestClient = Awaited<ReturnType<typeof getRequestClient>>` and the
 * four sites that pass the client as a parameter are untouched.
 *
 * TWO WAYS TO RESOLVE THE USER, checked in this order:
 *
 *   1. An ambient id from `runAsUser` - the workers, which have no request.
 *   2. The verified Cognito ID token in the session cookie - Next.
 *
 * Ambient first, deliberately. A worker must never fall through to reading
 * cookies: outside a request `cookies()` throws in Next 16, and an
 * accidentally-caught throw would leave `uid` null, which reads as "signed
 * out" and silently returns empty results rather than failing.
 *
 * The user id is resolved EAGERLY, here, rather than lazily inside
 * `auth.getUser()`. Only write paths call `currentUserId()`; every read calls
 * `.from()` with no id in hand, and each of those statements still needs
 * `app.user_id` set.
 */
export async function getRequestClient(): Promise<RequestClient> {
  const ambient = ambientUserId();
  if (ambient) return requestClientFor(ambient);

  // Imported lazily so a worker bundle never pulls `next/headers` in at all.
  const { getUser } = await import("../auth");
  const user = await getUser();
  return requestClientFor(user?.id ?? null);
}
