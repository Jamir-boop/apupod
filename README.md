# Local Podcast Builder

Small local web app for building reviewed podcast transcripts and rendered audio. No Docker or DB.

## Requirements

- Node.js 24+
- FFmpeg and FFprobe on `PATH`
- Browser on same machine

## Start

```powershell
Copy-Item .env.example .env
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4173`.

## Development

Run the TypeScript entrypoint directly:

```powershell
npm run dev
```

The Fastify shell currently delegates route behavior to `src/legacy-app.ts`. `app.mjs` and `defaults.mjs` remain compatibility shims for tests and existing imports.

## Views

- `Profiles`
  - `Speaker Profiles`: 1 to 4 speakers, default TTS model, per-speaker overrides.
  - `Episode Profiles`: speaker profile link, outline model, transcript model, required language, timing, briefing.
  - Shared `Save all profiles` action and compact profile summary pills.
- `Knowledge Base`: upload Markdown source.
- `Transcript Generator`: create episode, queue transcript job, review and save transcript.
- `TTS Generator`: review provider-aware preparation prompts, generate and approve a cue-annotated TTS script, preview speakers, optionally override TTS language, and render final MP3.
- `Config`: manage provider rows, endpoints, keys, and explicitly active LLM/TTS models. Save refreshes model catalog without restart.

## Providers

- `MiMo`
  - Text generation via `chat/completions`
  - TTS via `mimo-v2.5-tts`
- `ElevenLabs`
  - TTS models from `/v1/models`
  - Voice browser from `/v2/voices`
- `OpenAI-compatible`
  - Model discovery via `/models`
  - Transcript generation via `/chat/completions`
  - TTS via `/audio/speech`
  - Multiple named connections supported
- `OpenAI`
  - Built-in provider using `OPENAI_API_KEY`
  - Default API root: `https://api.openai.com/v1`
  - Separate LLM, TTS, and model URL overrides supported with one shared key
  - Script models and TTS models load from `/models` after Config save
  - TTS uses `/audio/speech`; `gpt-4o-mini-tts` supports expressive voice instructions
- `Chatterbox`
  - User-supplied OpenAI-compatible base URL
  - Model discovery via `/models`, voice discovery via `/voices`, and TTS via `/audio/speech`
  - API key is optional for local servers
  - Per-speaker exaggeration, CFG weight, and temperature controls are sent with TTS requests

Config discovers models but exposes only models explicitly activated as LLM, TTS, or both. Saved profile models are activated during legacy migration so existing profiles keep working. Custom compatible connections may omit API keys for local unauthenticated servers.

Saved API keys can be staged for removal with `Clear saved key`, then deleted by `Save config`. Blank key fields continue to mean “keep existing.”

## Language Rules

- Episode profile language is source of truth for transcript generation.
- Editable prompts no longer need language wording.
- Server injects hidden language rule during outline and transcript generation.
- TTS can override language per render/preview request without changing transcript text.
- MiMo preset TTS remains limited to English and Chinese.

## Duration Rules

- Generated transcripts require at least 125 spoken words per target minute.
- Short imported or edited transcripts remain renderable after a warning and confirmation.
- Rendering inserts cue-aware pauses and rejects final MP3s shorter than 90% of target duration.
- Rendering requires a current approved TTS script. Preparation preserves spoken words and adds only provider/model-supported cue annotations.
- Failed rerenders preserve the last successful MP3 when it was still valid before the job.

## Storage

- `data/profiles.json`: speaker profiles, episode profiles, episode seeds
- `data/config.json`: non-secret provider and compatible connection metadata
- `.env`: API keys and base URL values
- `data/episodes/*`: saved episodes, transcripts, audio, clip cache
- `data/episodes/*/tts-script.draft.md`: prepared script awaiting review
- `data/episodes/*/tts-script.md`: approved script used for rendering

Episodes store speaker and episode profile snapshots. Later profile edits do not alter existing transcripts or renders; save episode draft again to intentionally refresh its snapshots.

Reviewed transcript text remains authoritative when generation instructions change. Refreshing snapshots invalidates audio when language, speaker mapping, TTS model, voice, style, accent, or Chatterbox tuning changes. Stale MP3 files stay hidden until a successful render replaces them.

On startup, obsolete outline/transcript JSON, concat manifests, temporary files, and unused clip-cache entries are removed. Corrupt episode metadata is listed as unavailable instead of silently disappearing; repair its `episode.json` before destructive profile or provider changes.

Keys stay server-side. API responses return `hasApiKey`, never raw secret values.

The server binds to loopback, rejects cross-origin writes, prevents framing, and supports HTTP byte ranges for MP3 playback.

OpenAI and compatible TTS voices are AI-generated. Disclose that fact in published episodes. This app generates podcast scripts; it does not transcribe uploaded audio.

## Background Jobs

Transcript generation, TTS script preparation, and TTS rendering run through one local FIFO queue.

- `GET /api/jobs` exposes queue state
- Sidebar `Server Activity` shows latest jobs
- Active jobs are marked interrupted after restart

## Verify

```powershell
npm run check
npm test
npm run build
```
