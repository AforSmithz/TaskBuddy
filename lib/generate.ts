import type { EntryDetail, EstimationModel, Task } from "./types";
import { MIN_ESTIMATION_SAMPLES } from "./types";
import { DEFAULT_SIGMA } from "./forecast";
import { isLLMConfigured } from "./extraction";

// Follow-up message + end-of-day summary generators.
// LLM-backed when OpenRouter is configured, deterministic templates otherwise.

// --- Follow-up message ------------------------------------------------------

export async function generateFollowUp(entry: EntryDetail): Promise<string> {
  const myTasks = entry.tasks
    .filter((t) => t.status !== "done")
    .slice(0, 5)
    .map((t) => t.title);
  const questions = entry.open_questions
    .filter((q) => q.status !== "resolved")
    .slice(0, 4)
    .map((q) => q.question);
  const blockers = entry.tasks
    .filter((t) => t.status === "blocked" || t.blocked_by)
    .slice(0, 3)
    .map((t) => `${t.title} (${t.blocked_by ?? "blocked"})`);

  if (isLLMConfigured()) {
    try {
      const { callOpenRouter } = await import("./openrouter");
      return await callOpenRouter([
        {
          role: "system",
          content:
            "You write short, professional follow-up messages after meetings. " +
            "Keep it to one concise paragraph, warm but direct. Return only the message.",
        },
        {
          role: "user",
          content:
            `Meeting: ${entry.title}\n` +
            `My upcoming tasks: ${myTasks.join("; ") || "none"}\n` +
            `Open questions to confirm: ${questions.join("; ") || "none"}\n` +
            `Blockers: ${blockers.join("; ") || "none"}\n\n` +
            "Write a follow-up message confirming what I'll do and asking to " +
            "resolve the open questions and blockers.",
        },
      ]);
    } catch (err) {
      console.error("LLM follow-up failed, using template:", err);
    }
  }

  return templateFollowUp(entry.title, myTasks, questions, blockers);
}

function templateFollowUp(
  title: string,
  tasks: string[],
  questions: string[],
  blockers: string[],
): string {
  const parts: string[] = [
    `Hi team, quick follow-up from "${title}".`,
  ];
  if (tasks.length) {
    parts.push(
      `I'll be working on: ${tasks.join(", ")}.`,
    );
  }
  if (questions.length) {
    parts.push(
      `Before I go further, could you help confirm a few things: ${questions
        .map((q) => q.replace(/\?+$/, ""))
        .join("; ")}?`,
    );
  }
  if (blockers.length) {
    parts.push(
      `A couple of items are currently blocked — ${blockers.join(
        ", ",
      )} — so any input there would help me keep moving.`,
    );
  }
  parts.push("Thanks!");
  return parts.join(" ");
}

// --- End-of-day summary -----------------------------------------------------

export interface EODSummary {
  completed: string[];
  blocked: string[];
  in_review: string[];
  unfinished: string[];
  tomorrow_focus: string[];
  planning_accuracy: string;
}

/** Deterministic end-of-day summary derived from current task state. */
export function buildEODSummary(tasks: Task[]): EODSummary {
  const completed = tasks.filter((t) => t.status === "done");
  const blocked = tasks.filter((t) => t.status === "blocked");
  const inReview = tasks.filter((t) => t.status === "review");
  const unfinished = tasks.filter(
    (t) => t.status === "todo" || t.status === "in_progress",
  );

  // Tomorrow's focus: highest-priority work that is not done or blocked.
  const tomorrow = [...unfinished, ...inReview]
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, 4)
    .map((t) => t.title);

  return {
    completed: completed.map((t) => t.title),
    blocked: blocked.map((t) => `${t.title} — ${t.blocked_by ?? "blocked"}`),
    in_review: inReview.map((t) => t.title),
    unfinished: unfinished.map((t) => t.title),
    tomorrow_focus: tomorrow,
    planning_accuracy: planningAccuracy(completed),
  };
}

// --- Learned estimation bias ------------------------------------------------

/**
 * Fit the user's estimation bias from completed tasks — the statistical core
 * the forecast calibrates against (`planningAccuracy` above is its plain-English
 * cousin for the daily summary).
 *
 * For each done task with both an estimate and a logged actual, we take
 * `log(actual / estimated)`. Working in log space keeps the factor multiplicative
 * and symmetric (running 2× over and 2× under are equal-and-opposite), which is
 * exactly what the forecast's log-normal sampler expects. We return the mean
 * (systematic bias) and std dev (spread). Below `MIN_ESTIMATION_SAMPLES` there
 * isn't enough signal to trust, so we fall back to the unbiased default.
 */
export function estimationModel(tasks: Task[]): EstimationModel {
  const logs: number[] = [];
  for (const t of tasks) {
    if (t.status === "done" && t.estimated_minutes > 0 && t.actual_minutes > 0) {
      logs.push(Math.log(t.actual_minutes / t.estimated_minutes));
    }
  }
  const sampleSize = logs.length;

  if (sampleSize < MIN_ESTIMATION_SAMPLES) {
    // Not enough history — unbiased default (E[factor] = 1) at the default spread.
    return {
      meanLog: -(DEFAULT_SIGMA * DEFAULT_SIGMA) / 2,
      sigma: DEFAULT_SIGMA,
      sampleSize,
    };
  }

  const meanLog = logs.reduce((s, x) => s + x, 0) / sampleSize;
  const variance =
    logs.reduce((s, x) => s + (x - meanLog) ** 2, 0) / (sampleSize - 1);
  // Floor sigma so a run of near-identical ratios can't collapse the forecast
  // into false certainty.
  const sigma = Math.max(Math.sqrt(variance), 0.05);

  return { meanLog, sigma, sampleSize };
}

function planningAccuracy(completed: Task[]): string {
  const withBoth = completed.filter(
    (t) => t.estimated_minutes > 0 && t.actual_minutes > 0,
  );
  if (withBoth.length === 0) {
    return "Not enough time-tracking data yet — log actual time on completed tasks.";
  }
  const est = withBoth.reduce((s, t) => s + t.estimated_minutes, 0);
  const act = withBoth.reduce((s, t) => s + t.actual_minutes, 0);
  const diff = Math.round(((act - est) / est) * 100);
  if (diff === 0) return "Your estimates matched actual time exactly today.";
  return diff > 0
    ? `You underestimated tasks by ${diff}% today (${act} min actual vs ${est} min planned).`
    : `You overestimated tasks by ${Math.abs(
        diff,
      )}% today (${act} min actual vs ${est} min planned).`;
}
