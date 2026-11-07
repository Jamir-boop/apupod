---
name: apupod-hosts
description: Design apupod podcast hosts (host profiles with 1 to 4 speakers) and pick their TTS voices. Use when creating or changing hosts, voices, accents, delivery style, or TTS tuning in apupod.
---

# apupod hosts

A host profile holds 1 to 4 speakers, a default TTS model (`voiceModel`), and show rules (`instructions`). Episodes keep a snapshot of their hosts, so a change affects new scripts and renders, and stale audio renders again.

## Steps

1. Call `get_workspace` to see the existing host profiles and whether TTS is ready.
2. Call `list_tts_options` with the show's language (for example `es-419`). Pick `voiceModel` from its `models`. Check that the model supports the language (`languages`) and note its cue capability.
3. If `models` has no model that fits but `available` has one (a provider is ready, but its models are not active), activate it with `set_tts_models` (`models: [id]`, `active: true`), then use the returned active list. If both are empty, follow `tts.hint` (the user must add a key or fix the provider in Settings). Deactivate models (`active: false`) only when the user asks; apupod refuses to deactivate a model that a profile or episode uses.
4. Call `list_voices` with `model` (or `provider`). Use only voice IDs from that list.
5. Write the profile and save it with `save_host_profile`.
6. Offer `preview_voice` for important voices (`speakerProfileId` + `speakerIndex`, with an `episodeProfileId` for the language). Give the user the returned URL.
7. Then propose the Episode Format (`save_episode_format`) that uses this profile.

## Writing the speakers

- When the user describes hosts (names, personalities, dynamic), create a new profile that matches the description. Do not present the current profile's speakers as if they were the requested hosts.
- Use `id` to update the current profile only when the user wants to change these hosts. On update, the fields you give replace the saved ones; each speaker keeps its saved settings for fields you omit (matched by name). Pass `expectedRevision` from `get_workspace` so a parallel edit is not overwritten.
- For each speaker, write `name`, `backstory`, `personality`, and `style` (voice and delivery style). These feed the script. Add `accent` (at most 100 characters) only when it differs from the language default.
- Speaker names must be unique, one line, and must not contain `:`, `[`, `]`, or line breaks. The script uses these exact names. Do not replace a real host name with a generic `Speaker N`.
- The first speaker is the lead host and handles transitions. One speaker means a solo show.
- `ttsModelOverride` sets a different TTS model for one speaker. Leave it empty to use `voiceModel`.

## Voices

- A voice ID must come from `list_voices` for the speaker's model, or be a voice already saved on a profile.
- Chatterbox: use only discovered voice IDs. If the user has not chosen an exact Chatterbox voice ID, show the discovered IDs and ask them to choose. Never guess a voice from a speaker name.
- MiMo preset voices support only English and Chinese.
- OpenAI and compatible TTS voices are AI-generated. Remind the user to disclose this in published episodes.

## Tuning (optional)

Set tuning only when the user asks or the style needs it. `list_tts_options` returns the ranges and defaults under `settings`:

- Chatterbox: `chatterboxExaggeration` 0.25 to 2, `chatterboxCfgWeight` 0 to 1, `chatterboxTemperature` 0.05 to 5.
- MiMo: `mimoTemperature` 0 to 2, `mimoTopP` 0 to 1, `mimoInstructionPreset` (one of `mimoInstructionPresets`), `mimoInstructionText` (at most 500 characters).
- ElevenLabs: `elevenlabsStability` 0 to 1, `elevenlabsSimilarityBoost` 0 to 1, `elevenlabsStyle` 0 to 1, `elevenlabsSpeed` 0.7 to 1.2, `elevenlabsSeed` integer 0 to 4294967295, `elevenlabsUseSpeakerBoost` boolean, `elevenlabsTextNormalization` (`auto`, `on`, `off`). The v4 model ignores Style, Speed, and Speaker boost, and an accent cannot force a v4 accent.

If the user asks for a delivery change only, keep the host count, personas, voices, model, accent, language, and other tuning. If a request has numeric settings, use those numbers; do not replace them with values you infer from traits.

`jev_decide` can choose the TTS model, per-speaker voice, or delivery preset from the valid options (for example `fields: ["voiceModel", "speakers.0.voiceId"]`). It is optional; see the `apupod` skill.
