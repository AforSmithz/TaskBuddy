import "server-only";
import type { ExtractedSkill, SkillDecomposition } from "./types";
import type { ChatMessage } from "./openrouter";
import { callOpenRouterJSON } from "./openrouter";
import { isLLMConfigured } from "./extraction";

// Learning-goal decomposer (Engine 1, the LLM-proposes half of §0). Turns a
// stated learning goal into a prerequisite graph of skills + checkpoints. The
// LLM proposes the structure and the effort estimates; progress and scheduling
// are decided elsewhere. Falls back to an offline heuristic when no API key is
// configured, so the feature works without OpenRouter.

const SYSTEM_PROMPT = `You are TaskBuddy's learning coach. You turn a stated learning
goal into a prerequisite graph of concrete skills to master, ordered from
foundations to mastery.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "skills": [{
    "key": string,              // unique slug, e.g. "s1", referenced by prerequisites
    "title": string,            // the capability, phrased as something you can DO
    "description": string,      // one sentence: what mastering this looks like
    "prerequisites": string[],  // keys of skills that must be learned first
    "is_checkpoint": boolean,   // true for a verifiable milestone you can demonstrate
    "estimated_minutes": number // realistic practice time to attain this skill
  }]
}

Rules:
- Produce 5–9 skills. Order them foundations-first; later skills depend on earlier ones.
- prerequisites must reference earlier keys only — no cycles, no self-references.
- Phrase each title as a demonstrable capability ("Hold a 5-minute conversation"),
  not a topic ("Conversation"). Checkpoints are the ones you could prove to someone.
- Mark 2–4 skills as checkpoints: real milestones, spread across the graph (not all
  at the end). Foundational drills are usually NOT checkpoints.
- estimated_minutes is cumulative practice for THAT skill alone, not the whole goal.`;

/** Reject a semantically-empty decomposition so the model chain advances. */
function isUsable(d: SkillDecomposition): boolean {
  return Array.isArray(d?.skills) && d.skills.length > 0;
}

/**
 * Decompose a learning goal into a skill graph. Uses the LLM when configured,
 * otherwise a deterministic heuristic so the app stays usable offline.
 */
export async function decomposeLearningGoal(
  name: string,
  description: string | null,
): Promise<ExtractedSkill[]> {
  if (!isLLMConfigured()) return heuristicSkills(name);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Learning goal: ${name}${
        description ? `\n\nContext: ${description}` : ""
      }`,
    },
  ];

  try {
    const result = await callOpenRouterJSON<SkillDecomposition>(messages, {
      validate: isUsable,
    });
    return sanitizeSkills(result.skills);
  } catch (err) {
    console.error("decomposeLearningGoal failed, using heuristic:", err);
    return heuristicSkills(name);
  }
}

/**
 * Defensive clean-up of an LLM-proposed graph: drop prerequisite references to
 * unknown keys and any that would point at a later skill (which would imply a
 * cycle, since the prompt orders foundations-first). Keeps persistence honest
 * regardless of what the model returns.
 */
function sanitizeSkills(skills: ExtractedSkill[]): ExtractedSkill[] {
  const seen = new Set<string>();
  return skills.map((s) => {
    const prerequisites = (s.prerequisites ?? []).filter(
      (k) => k !== s.key && seen.has(k),
    );
    seen.add(s.key);
    return {
      key: s.key,
      title: s.title,
      description: s.description ?? "",
      prerequisites,
      is_checkpoint: Boolean(s.is_checkpoint),
      estimated_minutes:
        Number.isFinite(s.estimated_minutes) && s.estimated_minutes > 0
          ? Math.round(s.estimated_minutes)
          : 60,
    };
  });
}

/**
 * Offline fallback: a generic learn-anything ladder. Honest about being generic
 * — it's a scaffold to edit, not a real domain plan, used only without an API key.
 */
function heuristicSkills(name: string): ExtractedSkill[] {
  const subject = name.replace(/^learn(ing)?\s+/i, "").trim() || "the subject";
  return [
    {
      key: "s1",
      title: `Learn the fundamentals of ${subject}`,
      description: `Cover the core vocabulary and concepts of ${subject}.`,
      prerequisites: [],
      is_checkpoint: false,
      estimated_minutes: 120,
    },
    {
      key: "s2",
      title: `Practice the basics of ${subject} daily`,
      description: "Build a consistent practice habit on the foundations.",
      prerequisites: ["s1"],
      is_checkpoint: true,
      estimated_minutes: 300,
    },
    {
      key: "s3",
      title: `Apply ${subject} to a small real exercise`,
      description: "Use the basics on a concrete, self-contained task.",
      prerequisites: ["s2"],
      is_checkpoint: false,
      estimated_minutes: 180,
    },
    {
      key: "s4",
      title: `Tackle an intermediate ${subject} challenge`,
      description: "Stretch into harder material that combines fundamentals.",
      prerequisites: ["s3"],
      is_checkpoint: true,
      estimated_minutes: 360,
    },
    {
      key: "s5",
      title: `Demonstrate ${subject} on a complete project`,
      description: "Produce something end-to-end that proves real competence.",
      prerequisites: ["s4"],
      is_checkpoint: true,
      estimated_minutes: 480,
    },
  ];
}
