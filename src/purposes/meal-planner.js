/**
 * Purpose: meal-planner — weekly dinner planning from the recipes vault.
 *
 * The purpose is fully LLM-driven (like prediction-markets): each cycle it
 * reads the recipes vault (~~/recipes, obsidian-synced), the meal-planner
 * state dir (~/.config/dude/meal-planner/), recent discord feedback, then
 * writes a weekly plan to the main vault, posts the plan + shopping list
 * to discord, and schedules prep via google calendar. All judgment lives
 * in the meal-planner skill; this module just wires the prompt + skill.
 */

export default {
  description:
    "weekly meal planner: recipes vault + pantry state -> plan, shopping list, prep schedule",
  prompt: `you are the meal-planner purpose. it is most likely sunday's weekly
planning cycle (or a mid-week catch-up — the --context / date tells you which).
follow the standing orders in the meal-planner skill:

1. read the meal-planner skill (SKILL.md) fully before acting.
2. read the recipes vault (~/recipes), state dir (~/.config/dude/meal-planner/)
   and recent discord messages for feedback/pantry updates.
3. produce the weekly plan + shopping list, deliver to discord, schedule prep,
   and update state files.

if anything is genuinely ambiguous, default to sensible behavior and note the
assumption in the discord post — john can correct via reply.`,
  skillPaths: ["meal-planner"],
  // skip the full ai-tasks base prompt (see prediction-markets.js rationale)
  trimBasePrompt: true,
};