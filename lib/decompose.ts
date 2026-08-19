import "server-only";
import type { ExtractedSkill, SkillDecomposition } from "@/lib/types";
import type { ChatMessage } from "@/lib/bedrock";
import { callBedrockJSON } from "@/lib/bedrock";
import { isLLMConfigured } from "@/lib/extraction";

// Learning-goal decomposer. Turns a stated learning goal into a prerequisite graph of skills and
// checkpoints. The LLM proposes the structure and the effort estimates; progress and scheduling
// are decided elsewhere. Falls back to an offline heuristic with no API key.

const MIN_SKILLS = 3;
const MAX_SKILLS = 9;
const MIN_MINUTES = 30;
const MAX_MINUTES = 1200;

const SYSTEM_PROMPT = `Turn a stated learning goal into a prerequisite graph of concrete skills to master.

Rules:
- Produce 5 to 9 skills. Never more than 9: a longer list is worse than a shorter one.
- List skills in topological order: a skill's prerequisites must all appear earlier in the array. Parallel foundations with no prerequisites are fine and expected. Do not invent a dependency to force a single chain.
- Phrase each title as a demonstrable capability ("Hold a 5-minute conversation"), not a topic ("Conversation").
- Exactly 2 to 4 skills are checkpoints. A skill is a checkpoint if and only if someone else could watch you do it and agree you can do it. When in doubt it is NOT a checkpoint. At least one checkpoint sits in the first half of the list, and the final skill is always one.
- estimated_minutes is practice time for THAT skill alone, not the whole goal, in minutes, between 30 and 1200.
- Write titles and descriptions in the same language as the stated goal.
- If the goal is empty, nonsensical, or is not a learning goal at all (an errand or a one-off task), return an empty skills array and nothing else.`;

// Strict schema. The per-field guidance that used to live in the prompt's shape block now rides
// on the property descriptions, where the model reads it beside the constraint. The 5-9 count
// and 2-4 checkpoint count can't be expressed here, so they stay in prose and are enforced below.
const DECOMPOSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skills"],
  properties: {
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "title",
          "description",
          "prerequisites",
          "is_checkpoint",
          "estimated_minutes",
        ],
        properties: {
          key: {
            type: "string",
            description: 'Lowercase slug, unique within this response, e.g. "s1".."s9".',
          },
          title: {
            type: "string",
            description: "The capability, phrased as something you can DO.",
          },
          description: {
            type: "string",
            description: "One sentence, at most 20 words, on what mastering this looks like.",
          },
          prerequisites: {
            type: "array",
            items: { type: "string" },
            description: "Keys of skills appearing EARLIER in this array.",
          },
          is_checkpoint: {
            type: "boolean",
            description: "A milestone someone else could watch you demonstrate.",
          },
          estimated_minutes: {
            type: "integer",
            description: "Practice minutes for this skill alone, 30 to 1200.",
          },
        },
      },
    },
  },
} as const;

/** Reject a decomposition the pipeline can't use, so the fallback chain advances. An EMPTY array
 *  is deliberately fine - the prompt uses it to mean "this isn't a learning goal", which is a
 *  real answer. What's rejected is an over-long graph or duplicate keys, neither of which a
 *  strict schema catches. */
function isUsable(d: SkillDecomposition): boolean {
  if (!Array.isArray(d?.skills)) return false;
  if (d.skills.length === 0) return true;
  if (d.skills.length < MIN_SKILLS || d.skills.length > 12) return false;
  const keys = d.skills.map((s) => s?.key);
  return new Set(keys).size === keys.length;
}

/** Decompose a learning goal into a skill graph. LLM when configured, deterministic heuristic
 *  otherwise so the app stays usable offline. */
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
    const result = await callBedrockJSON<SkillDecomposition>(messages, {
      schema: DECOMPOSITION_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "skill_decomposition",
      // The one genuinely structural call in the codebase: ordering, dependency
      // structure and checkpoint placement. It was the worst served by the low
      // effort the old wrapper hardcoded for every caller.
      reasoningEffort: "medium",
      validate: isUsable,
    });
    // An empty graph is the model saying "not a learning goal". Respect it
    // rather than substituting the generic ladder, which would look like a
    // successful decomposition of nonsense.
    return sanitizeSkills(result.skills);
  } catch (err) {
    console.error("decomposeLearningGoal failed, using heuristic:", err);
    return heuristicSkills(name);
  }
}

/** Defensive clean-up of a proposed graph: drop prerequisite references to unknown keys and any
 *  pointing at a later skill (which would imply a cycle, since the prompt orders
 *  foundations-first). Still load-bearing under a strict schema - the graph invariant, the count
 *  cap and the minute range are all outside what JSON Schema can express. */
function sanitizeSkills(skills: ExtractedSkill[]): ExtractedSkill[] {
  const seen = new Set<string>();
  return skills.slice(0, MAX_SKILLS).map((s) => {
    const prerequisites = (s.prerequisites ?? []).filter(
      (k) => k !== s.key && seen.has(k),
    );
    seen.add(s.key);
    const minutes = Math.round(Number(s.estimated_minutes));
    return {
      key: s.key,
      title: s.title,
      description: s.description ?? "",
      prerequisites,
      is_checkpoint: Boolean(s.is_checkpoint),
      estimated_minutes: Number.isFinite(minutes)
        ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes))
        : 60,
    };
  });
}

/** Offline fallback: a generic learn-anything ladder. Honest about being generic - a scaffold to
 *  edit, not a real domain plan. */
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
