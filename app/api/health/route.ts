// Readiness probe for the AWS Lambda Web Adapter.
//
// The adapter polls AWS_LWA_READINESS_CHECK_PATH until it answers before
// forwarding the first request. Without a probe it starts forwarding as soon as
// the process spawns, and every cold start races `next start`'s own boot - the
// symptom is intermittent 502s that appear only under real traffic, are
// invisible in Lambda's Errors metric (the invocation succeeded), and show up
// solely as CloudFront 5xx. That is what the taskbuddy-cdn-5xx alarm watches.
//
// DELIBERATELY TOUCHES NOTHING. No database, no Cognito, no Bedrock. This
// answers "is the Node process serving HTTP yet", which is the only question
// the adapter is asking. A probe that checked Aurora would fail while the
// cluster resumed from auto-pause and take the whole function out of service
// for the fifteen seconds it takes to wake - turning a slow first request into
// an outage. Dependency health belongs in an alarm, not in a liveness gate.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
