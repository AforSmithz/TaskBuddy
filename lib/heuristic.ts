import type { ExtractionResult, ExtractedTask, Confidence } from "./types";

// Offline heuristic extractor.
// Used when Foundry is not configured so the full pipeline still works.
// It is intentionally rule-based - good enough to demo the workflow end to end.

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const ACTION_RE =
  /\b(will|need(?:s)? to|should|must|to do|follow[- ]up|prepare|create|build|clean|review|send|confirm|draft|finalize|finalise|update|schedule|set up|investigate|fix|write|design|test|deploy|present|analyze|analyse|check|validate)\b/i;

const DECISION_RE =
  /\b(decided|we'?ll use|let'?s use|agreed|going with|the decision is|chose|we will use|settled on)\b/i;

const QUESTION_RE =
  /\b(unclear|not sure|tbd|to be determined|need to confirm|needs? clarification|who will|still open|open question|unresolved)\b/i;

const ASSUMPTION_RE = /\b(assume|assuming|assumption)\b/i;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a relative date phrase ("Friday", "tomorrow") to an ISO date. */
function parseDue(sentence: string): string | null {
  const lower = sentence.toLowerCase();
  const today = new Date();

  if (/\btoday\b/.test(lower)) return isoDate(today);
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return isoDate(d);
  }
  if (/\b(end of (the )?week|this week)\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 5));
    return isoDate(d);
  }
  if (/\bnext week\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    return isoDate(d);
  }
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(lower)) {
      const d = new Date(today);
      const delta = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return isoDate(d);
    }
  }
  // Explicit ISO-ish date.
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  return null;
}

/** Urgency rating (1-5) from how soon a due date falls. */
function urgencyFromDue(due: string | null): number {
  if (!due) return 1;
  const days = Math.round(
    (new Date(due).getTime() - Date.now()) / 86_400_000,
  );
  if (days <= 1) return 5;
  if (days <= 3) return 4;
  if (days <= 7) return 3;
  if (days <= 14) return 2;
  return 1;
}

/** Effort rating (1-5) from an estimated-minutes value. */
function effortFromMinutes(min: number): number {
  if (min > 240) return 5;
  if (min > 120) return 4;
  if (min > 60) return 3;
  if (min >= 30) return 2;
  return 1;
}

function extractOwner(sentence: string): string | null {
  const m = sentence.match(
    /\b([A-Z][a-z]{1,15})\s+(?:will|is going to|needs? to|should|to)\b/,
  );
  return m ? m[1] : null;
}

function shorten(sentence: string, max = 80): string {
  const clean = sentence.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

// Life-area keyword cues. Used to suggest Work/Personal/Hobby for an entry
// when the user leaves the category on "Auto".
const HOBBY_RE =
  /\b(learn|learning|practi[cs]e|hobby|guitar|piano|violin|drum|ukulele|instrument|paint|draw|sketch|cook|bak(?:e|ing)|garden|chess|photograph|language|spanish|french|japanese|sing|dance|knit|run(?:ning)?|jog|gym|workout|fitness|yoga|climb|sport|football|tennis|hike|read(?:ing)? books?)\b/i;
const PERSONAL_RE =
  /\b(family|kids?|home|house|move|apartment|doctor|dentist|health|budget|finance|saving|tax(?:es)?|wedding|birthday|trip|holiday|vacation|grocer|errand|chores?|personal|relationship|friends?)\b/i;

/** Suggest a life-area for an entry from keyword cues; defaults to "Work". */
function lifeArea(text: string): string {
  if (HOBBY_RE.test(text)) return "Hobby";
  if (PERSONAL_RE.test(text)) return "Personal";
  return "Work";
}

function categorize(sentence: string): string {
  const l = sentence.toLowerCase();
  if (/\b(data|dataset|clean|missing values?)\b/.test(l)) return "Data";
  if (/\b(dashboard|chart|visual|report)\b/.test(l)) return "Dashboard";
  if (/\b(present|stakeholder|summary|communicat)\b/.test(l)) return "Communication";
  if (/\b(review|validate|test|qa)\b/.test(l)) return "Review";
  if (/\b(design|spec|plan)\b/.test(l)) return "Planning";
  return "General";
}

/** Strip leading intent phrases so "I want to learn piano" -> "learn piano". */
function coreGoal(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(i\s+(want|need|would like|'?d like|plan|hope|aim)\s+to\s+|my goal is to\s+|i'?m going to\s+|let'?s\s+)/i,
      "",
    )
    .replace(/[.!?]+$/, "");
}

/**
 * Offline heuristic for goal/plan input. The LLM produces a far richer plan;
 * this keeps demo mode (no API key) usable by decomposing a goal into a few
 * sensible milestone tasks.
 */
export function heuristicPlan(rawInput: string): ExtractionResult {
  const goal = coreGoal(rawInput) || "reach my goal";
  const dueIn = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return isoDate(d);
  };

  const steps: { title: string; description: string; day: number; min: number }[] = [
    {
      title: `Plan and gather resources to ${goal}`,
      description: `Define what success looks like and collect the tools, materials, or references needed to ${goal}.`,
      day: 1,
      min: 45,
    },
    {
      title: `First focused session: ${goal}`,
      description: `Make a concrete start — a first dedicated work or practice block toward "${goal}".`,
      day: 2,
      min: 60,
    },
    {
      title: "Build a repeatable daily routine",
      description: `Schedule a recurring block so progress on "${goal}" compounds instead of stalling.`,
      day: 3,
      min: 30,
    },
    {
      title: "Mid-point checkpoint",
      description: `Review progress, note what is working, and adjust the approach to "${goal}".`,
      day: 5,
      min: 30,
    },
    {
      title: "Review progress and set next steps",
      description: `Assess how far you got toward "${goal}" and decide what to carry forward.`,
      day: 7,
      min: 30,
    },
  ];

  const tasks: ExtractedTask[] = steps.map((s, i) => {
    const due = dueIn(s.day);
    return {
      key: `g${i + 1}`,
      title: shorten(s.title, 90),
      description: s.description,
      owner: null,
      category: "Planning",
      due_date: due,
      estimated_minutes: s.min,
      source_quote: null,
      is_ai_suggested: true,
      blocked_by: null,
      depends_on: i > 0 ? [`g${i}`] : [],
      urgency: urgencyFromDue(due),
      impact: i === 1 || i === 2 ? 4 : 3,
      dependency: i < steps.length - 1 ? 3 : 1,
      risk: 2,
      effort: effortFromMinutes(s.min),
      confidence: 3,
      priority_reason: "Suggested step toward the stated goal.",
    };
  });

  const title = shorten(goal.charAt(0).toUpperCase() + goal.slice(1), 70);
  return {
    title,
    summary: `A suggested plan to ${goal}, broken into ${tasks.length} steps over the coming week.`,
    // A personal goal always warrants its own project to group its steps.
    suggested_area: lifeArea(rawInput),
    suggested_project: title,
    discussion_points: [],
    stakeholders: [],
    daily_objective: `Make steady progress toward: ${goal}.`,
    key_deliverables: [`A clear, actionable plan to ${goal}`],
    assumptions: ["The plan assumes time can be set aside on most days."],
    risks: ["Losing momentum if the routine is not kept up."],
    decisions: [],
    open_questions: [],
    tasks,
  };
}

export function heuristicExtract(rawInput: string): ExtractionResult {
  const text = rawInput.trim();
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sentences = splitSentences(text);

  const firstLine = lines[0] ?? "Untitled meeting";
  const title =
    firstLine.length <= 70 && !ACTION_RE.test(firstLine)
      ? firstLine.replace(/[:.\s]+$/, "")
      : `Meeting notes — ${isoDate(new Date())}`;

  // --- Decisions ---
  const decisions = sentences
    .filter((s) => DECISION_RE.test(s))
    .slice(0, 8)
    .map((s) => ({
      decision: shorten(s, 120),
      source_quote: s,
      confidence: "Medium" as Confidence,
    }));

  // --- Open questions ---
  const open_questions = sentences
    .filter((s) => s.endsWith("?") || QUESTION_RE.test(s))
    .slice(0, 8)
    .map((s) => ({
      question: shorten(s, 120),
      related_stakeholder: extractOwner(s),
      source_quote: s,
      confidence: "Medium" as Confidence,
    }));

  // --- Explicit tasks ---
  const taskSentences = sentences.filter(
    (s) => ACTION_RE.test(s) && !s.endsWith("?") && !DECISION_RE.test(s),
  );

  const tasks: ExtractedTask[] = taskSentences.slice(0, 14).map((s, i) => {
    const due = parseDue(s);
    const estimated = /\b(quick|brief|short)\b/i.test(s) ? 30 : 60;
    const owner = extractOwner(s);
    const highImpact = /\b(deliverable|stakeholder|dashboard|present|launch|deadline)\b/i.test(
      s,
    );
    const urgency = urgencyFromDue(due);
    return {
      key: `t${i + 1}`,
      title: shorten(s),
      description: s,
      owner,
      category: categorize(s),
      due_date: due,
      estimated_minutes: estimated,
      source_quote: s,
      is_ai_suggested: false,
      blocked_by: null,
      depends_on: [],
      urgency,
      impact: highImpact ? 4 : 3,
      dependency: /\b(before|first|then|after|depends)\b/i.test(s) ? 4 : 2,
      risk: highImpact ? 4 : 3,
      effort: effortFromMinutes(estimated),
      confidence: 5,
      priority_reason: `Explicitly mentioned in the meeting${
        due ? ` with a due date of ${due}` : ""
      }.`,
    };
  });

  // --- Suggested missing tasks ---
  if (tasks.length > 0) {
    const suggestions: { title: string; category: string }[] = [
      { title: "Review assumptions before execution", category: "Planning" },
      { title: "Prepare a stakeholder-friendly summary", category: "Communication" },
    ];
    suggestions.forEach((sg, i) => {
      tasks.push({
        key: `s${i + 1}`,
        title: sg.title,
        description: "Suggested follow-up task to support the meeting objective.",
        owner: null,
        category: sg.category,
        due_date: null,
        estimated_minutes: 45,
        source_quote: null,
        is_ai_suggested: true,
        blocked_by: null,
        depends_on: [],
        urgency: 2,
        impact: 3,
        dependency: 2,
        risk: 3,
        effort: 2,
        confidence: 3,
        priority_reason: "Implied by the meeting objective but not stated directly.",
      });
    });
  }

  const assumptions = sentences
    .filter((s) => ASSUMPTION_RE.test(s))
    .slice(0, 5)
    .map((s) => shorten(s, 120));

  const stakeholders = Array.from(
    new Set(
      tasks
        .map((t) => t.owner)
        .concat(open_questions.map((q) => q.related_stakeholder))
        .filter((x): x is string => Boolean(x)),
    ),
  );

  const summary =
    sentences.slice(0, 3).join(" ") ||
    `Notes covering ${tasks.length} action item(s) and ${decisions.length} decision(s).`;

  return {
    title,
    summary,
    suggested_area: lifeArea(text),
    // A meeting doesn't necessarily form its own project - leave it to the user.
    suggested_project: null,
    discussion_points: sentences.slice(0, 6).map((s) => shorten(s, 110)),
    stakeholders,
    daily_objective:
      tasks.length > 0
        ? `Make progress on ${tasks.length} action item(s), starting with "${tasks[0].title}".`
        : "Review the meeting notes and define next steps.",
    key_deliverables: tasks
      .filter((t) => t.impact >= 4 && !t.is_ai_suggested)
      .slice(0, 4)
      .map((t) => t.title),
    assumptions,
    risks: open_questions.slice(0, 4).map((q) => `Unresolved: ${q.question}`),
    decisions,
    open_questions,
    tasks,
  };
}
