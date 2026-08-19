import { callBedrockJSON } from "@/lib/bedrock";
import { VERDICT_SCHEMA } from "@/lib/skill-links";

/**
 * Judges one (task, skill) pair. One Distributed Map item, one invocation.
 *
 * filterVerified in lib/skill-links.ts already judges pairs concurrently with an in-process cap,
 * and it fails CLOSED - a judgement that errors drops the pair rather than admitting an unchecked
 * link. Right default, wrong failure mode at scale: a burst of Bedrock throttles silently deletes
 * good suggestions and reports success, which is exactly what happened once already.
 *
 * As a Map item the same burst is a retry with backoff Step Functions owns, the concurrency cap
 * is enforced by the service rather than a semaphore that resets on recycle, and a pair that
 * still can't be judged is a recorded failure in the execution history instead of a `false`
 * nobody can distinguish from a considered no.
 *
 * No database. This judges text and returns a verdict; persistence is the worker's job. Keeping
 * it out means no connection is held open across a fan-out of thirty items, which would defeat
 * Aurora auto-pause for the whole run.
 */

const SYSTEM_PROMPT = `You judge whether performing a TASK necessarily demonstrates a SKILL.

Answer TRUE only when doing the task inherently exercises the skill. You are not
judging mastery, and you are not judging whether the task is related to the skill.
You are judging whether the act contains the act.

Write "why" first and let it decide the verdict, not the other way round. "why"
contains no numbers, scores, percentages or estimates.`;

interface Item {
  taskId: string;
  skillNodeId: string;
  taskTitle: string;
  skillTitle: string;
}

export interface Verdict extends Item {
  demonstrates: boolean;
  why: string | null;
  /** True when the judge could not reach a verdict. Distinct from a considered no. */
  errored: boolean;
}

export async function handler(item: Item): Promise<Verdict> {
  try {
    const verdict = await callBedrockJSON<{ why: string; demonstrates: boolean }>(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `TASK: ${item.taskTitle}\nSKILL: ${item.skillTitle}`,
        },
      ],
      {
        schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "link_verdict",
        // A single yes/no with two titles in context.
        reasoningEffort: "low",
        // Small on purpose. The schema is one sentence and one boolean, and a
        // generous ceiling here would reserve quota per item across a fan-out.
        maxCompletionTokens: 512,
      },
    );
    return { ...item, demonstrates: verdict.demonstrates === true, why: verdict.why, errored: false };
  } catch (err) {
  // Rethrown, not swallowed, and this is the whole reason the fan-out moved out of process.
  // Throwing lets Step Functions apply the retry policy for throttles; only after those are
  // exhausted does the item fail, and then it's visible. Returning `demonstrates: false` here
  // would recreate the exact silent-deletion bug this function exists to fix.
    console.error(`judge failed for ${item.taskId}/${item.skillNodeId}:`, err);
    throw err;
  }
}
