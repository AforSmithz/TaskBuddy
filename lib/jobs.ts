import "server-only";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { Job } from "@/lib/job-handlers";

// Publishing side of the async pipeline.
//
// EventBridge rather than SQS directly, and the extra hop is the point: sending straight to the
// queue would hard-wire "decomposing a goal" to "the LLM worker runs", so the day something else
// needs to react to the same fact - a notification, an audit row, a cache warm - the producer has
// to change. The bus lets a second consumer subscribe to an event that already exists.
//
// The routing rule is an explicit detail-type allow-list rather than { source: ["taskbuddy"] },
// so adding an event type here does NOT silently start feeding the LLM queue. Add it to the rule
// deliberately or it goes nowhere, which is the safe direction.

let client: EventBridgeClient | null = null;
function bus(): EventBridgeClient {
  if (!client) {
    client = new EventBridgeClient({
      region:
        process.env.AWS_REGION_NAME ?? process.env.AWS_REGION ?? "ap-southeast-1",
      maxAttempts: 3,
    });
  }
  return client;
}

/** True when there is a bus to publish to. Local dev has none. */
export function isQueueConfigured(): boolean {
  return Boolean(process.env.EVENT_BUS_NAME);
}

/** Publish one domain event.
 *
 *  Returns rather than throws on a publish failure: a caller that has already written its own
 *  state must not be rolled back because a downstream notification didn't land, and every caller
 *  here is in that position. The failure is logged and surfaces through the FailedEntryCount the
 *  SDK reports, which is what the DLQ alarm ultimately watches. False means it didn't reach the
 *  bus, so a caller can fall back to running the work inline. */
export async function publish(job: Job): Promise<boolean> {
  const busName = process.env.EVENT_BUS_NAME;
  if (!busName) return false;
  try {
    const res = await bus().send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: "taskbuddy",
            DetailType: job.type,
            Detail: JSON.stringify(job),
          },
        ],
      }),
    );
    // PutEvents answers 200 with a per-entry failure count. Not checking this
    // is the classic EventBridge mistake: the call "succeeds" and the event was
    // never accepted.
    if ((res.FailedEntryCount ?? 0) > 0) {
      console.error("eventbridge rejected entry:", res.Entries?.[0]);
      return false;
    }
    return true;
  } catch (err) {
    console.error("eventbridge publish failed:", err);
    return false;
  }
}
