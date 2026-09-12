# Agent Notes

- When adding a TTS provider, review the provider's official API docs first.
- Add matching UI controls, saved speaker fields, validation, default values, request payload mapping, examples/tooltips, docs links where known, and tests.
- ElevenLabs TTS docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- MiMo TTS docs: https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5

## Version Bumping

After completing a modification or implementing a new feature, update the app
version in `package.json`. `package-lock.json` must match: a test asserts the
two agree, so bump both with `npm version --no-git-tag-version <x.y.z>`.

Rules:

- Refactor or fix (no new user-facing behavior): stay on `master`, bump patch
  (`x.x.+1`). Example: `0.3.2` → `0.3.3`.
- New feature or addition to existing feature: stay on `master`, bump minor
  (`x.+1.0`). Example: `0.3.3` → `0.4.0`.
- Breaking change to saved data shapes or the HTTP API: bump major
  (`+1.0.0`), resetting minor and patch. Example: `0.4.1` → `1.0.0`.
- Repo hygiene that touches no runtime file (gitignore, tracked-file changes)
  needs no bump.
- Never create a new branch unless the user explicitly asks for one.
