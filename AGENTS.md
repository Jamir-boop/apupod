# Agent Notes

## Product rules

- apupod makes no LLM calls. Do not add text-model providers, prompt generation, or chat flows to the app. The user's agent harness does all text work through MCP tools and skills.
- Every new user-facing feature needs an MCP tool in `src/mcp.mjs` (or a change to an existing tool) and an update to the skills in `skills/` that describe the workflow. Use the same core functions as the REST handlers; do not duplicate rules.
- Skills reference tools by their exact names. `test/packaging.test.mjs` fails when a skill names a tool that does not exist.
- MCP tools never accept, return, or log key values. Report only `hasApiKey` flags.
- Exception to the tool rule: system changes (port, MCP token, update in Settings > System, `src/system.mjs`) stay UI-only and have no MCP tools. `get_workspace` may only report the version, the update status, and the last MCP connections.

## TTS providers

- When adding a TTS provider, review the provider's official API docs first.
- Add matching UI controls, saved speaker fields, validation, default values, request payload mapping, examples/tooltips, docs links where known, and tests.
- ElevenLabs TTS docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- MiMo TTS docs: https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5

## Version Bumping

After completing a modification or implementing a new feature, bump the app
version with `npm version --no-git-tag-version <x.y.z>`. npm writes
`package.json` and `package-lock.json`, then its `version` script
(`scripts/sync-version.mjs`) writes the same version to every other place:

- `.claude-plugin/plugin.json` and the root `plugin.json`.
- The npx pin `github:Jamir-boop/apupod#v<version>` in `.mcp.json`, `mcp.json`, `examples/opencode.json`,
  the OpenCode snippet in the Settings view (`public/index.html`), and `README.md`.

Then push the commit and the tag `v<version>`: the plugins run that tag from GitHub,
and Settings > Update reads the tags. `test/packaging.test.mjs` fails when one place differs.
A push runs the tests on GitHub Actions (`.github/workflows/test.yml`).

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
