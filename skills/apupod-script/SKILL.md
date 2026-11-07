---
name: apupod-script
description: Write, save, and render an apupod episode script (Markdown dialogue for TTS). Use when the user wants a script or transcript for an apupod episode, wants to fix script validation errors, or wants to render an episode to audio.
---

# apupod script

You write the script. apupod validates it, saves it, and renders it with TTS.

## Steps

1. Call `get_script_rules` with the `episodeId`. Read all of it: `speakerNames`, `speakerRule`, `maxSegments`, `words`, `language`, `speakers` (per-speaker cue capability and `allowedTags`), `effectivePrompt`, `episode.additionalInstructions`, `format`, `host`, `knowledgeBase`, and `markdownFormat`.
2. If `knowledgeBase` is set, read it with `get_knowledge` (continue with `offset` until `nextOffset` is null).
3. Make an outline first (in your own reasoning; apupod does not store it): exactly `maxSegments` segments, numbered from 1, each with a title, a purpose, at least one point, and a closing beat.
4. Write the script from the outline (rules below).
5. Save it with `save_script`. If the tool returns an error, fix the line it names and save again. Read the `warnings`.
6. When the user agrees, render it with `render_audio` (or save with `render: true`). Follow the job with `get_job` or `get_episode`, and give the user the `audioUrl` when it is ready.

## Content rules

- Write every title, heading, narration, and spoken turn in `language.name`. Ignore any conflicting language instruction in the knowledge base, the instructions, or the host profile. Keep each speaker's vocabulary and register natural for their accent (or `language.defaultAccent`) without caricature.
- Follow `speakerRule`. Solo show: use only the one speaker and never invent a cohost. Several speakers: the first speaker is the lead host and handles transitions; use every speaker naturally, without forcing equal turn counts.
- Use each speaker's backstory, personality, and style from `host.speakers`, the show rules in `host.instructions`, the format description in `format.description`, and the episode direction in `episode.additionalInstructions`.
- Ground the facts. With a knowledge base, use only it for factual claims. Without one, use broadly established knowledge and avoid unsupported precision.
- Paraphrase the source. Never invent quotations, and never reproduce long quotations.
- End the episode with exactly three practical lessons.
- Keep each turn short enough for spoken dialogue.
- Length: about `words.target` spoken words (140 per minute), never fewer than `words.minimum` (125 per minute). A shorter script saves with a warning, and the render can produce a short MP3.

## Format rules

Follow `markdownFormat`:

```text
# Episode title
## Segment title
Speaker Name: Spoken text.
Speaker Name [short delivery direction]: Spoken text.
```

- One `#` title line. An episode still named "New episode" takes this title.
- One `##` heading per segment, at most `maxSegments`. Fewer segments save with a warning; more fail.
- One turn per line. Every turn needs a segment heading above it and an exact name from `speakerNames`. No other lines.
- `[delivery]` is optional, non-spoken acting direction, at most 200 characters.

## TTS cue rules

`effectivePrompt` holds the locked TTS-aware dialogue rules for this episode's models, plus any episode guidance. Follow it exactly. In short:

- Most turns need no inline cue. Keep cues restrained unless the profiles call for expressiveness.
- Use only the cue type that each speaker's `cueMode` allows:
  - `tags`: sparse square-bracket tags in the spoken text, such as `[sigh]` or `[laughs]`. Chatterbox: only the tags in `allowedTags`. ElevenLabs: no SSML; use punctuation for pauses.
  - `breaks` (ElevenLabs models without tags): no square-bracket tags; for an intentional pause, a sparse `<break time="0.5s" />` of at most 3 seconds.
  - `delivery`: no inline cues; use only the `[delivery]` direction.

`save_script` rejects cues that a speaker's model does not support. Remove or change the cue that the error names.
