---
name: apupod-plan
description: Plan an apupod podcast series (content plan with planned episodes), optionally from a Markdown knowledge base. Use when the user wants a series, an episode list, or a plan for a show in apupod.
---

# apupod plan

A content plan has a theme, audience, goal, episode count, hosts, Episode Format, optional knowledge base, and the planned episode list that you write.

## Steps

1. Call `get_workspace`. Find the host profile, the Episode Format, and the knowledge base to use.
2. If there is a knowledge base, read all of it with `get_knowledge` (continue with `offset` until `nextOffset` is null).
3. Write the plan (rules below) and save it with `save_plan`.
4. Show the user the titles and episode 1. When they agree, call `create_episodes` with the `planId` and the `plannedEpisodeIds` to produce.

## save_plan input

- Plan fields: `name`, `theme`, `audience`, `goal`, `episodeCount` (1 to 100, or null to let the list decide), `knowledgeBaseId`, `speakerProfileId`, `episodeFormatId`, `language`, `targetMinutes`.
- `episodes`: the whole list in order, `number` from 1. Each item has `title` and can have `premise`, `knowledgeScope`, `keyPoints` (at most 20), `listenerOutcome`, `episodeProfileId`, `additionalInstructions`, and `transcriptPromptGuidance`.
- If the plan has no `episodeFormatId`, give `episodeFormat: {name, description}`. apupod then creates an Episode Format with the plan's hosts, language, and `targetMinutes`, and points every planned episode at it. The name and description must capture the user's intent.
- To update a plan, pass its `id` and `expectedUpdatedAt` (from `get_plan`). Fields you omit keep their saved values. `episodes` replaces the whole list: give an existing planned episode's `id` to keep it. You cannot drop a planned episode that already has a created episode.

## Writing the plan

- Derive a missing theme, audience, or goal from the user's words.
- With an `episodeCount`, write exactly that many episodes. Without one, choose a count from 1 to 100 that fits the plan and the source. Do not pad the series.
- Write a title for every episode. Write full detail (premise, knowledge scope, key points, listener outcome, and instructions when useful) for episode 1. Add detail to later episodes when the user asks, or before you create them.
- Avoid overlap between episodes. Every episode must stand alone.
- Do not write the script here. Do not invent quotations.
- With a knowledge base, use it as the source and set each episode's `knowledgeScope` to the part it covers. Without one, avoid unsupported precise claims.
- `additionalInstructions` and `transcriptPromptGuidance` (at most 50000 characters) carry episode-specific direction into the script step.

`create_episodes` writes the plan's theme, goal, audience, premise, knowledge scope, key points, listener outcome, and instructions into each episode's `additionalInstructions`. `get_script_rules` returns them when you write the script (see the `apupod-script` skill).
