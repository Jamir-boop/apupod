# pod-god

Small local web app for building reviewed podcast transcripts and rendered audio. No Docker or DB.

## Requirements

- Node.js 24+
- FFmpeg and FFprobe on `PATH`
- Browser on same machine

## Start

```powershell
Copy-Item .env.example .env
npm start
```

Open `http://127.0.0.1:4173`.

## Development

Run with automatic environment loading:

```powershell
npm run dev
```

`server.mjs` is the runtime entrypoint. `app.mjs` and `defaults.mjs` expose server and default-data APIs.

## Views

- `Speaker Profiles`: 1 to 4 speakers, default TTS model, per-speaker overrides, and speaker assistant.
- `Podcast Assistant` and `Episodes`: describe a podcast in chat, upload optional Markdown, review proposed hosts and formats, then create and run episode drafts.
- `Transcript Generator`: open saved episodes, review provider/model cue rules, generate transcripts, and edit canonical text.
- `TTS Generator`: preview speakers, optionally override TTS language, and render final MP3.
- `Player`: play rendered episodes, change playback speed, manage an in-memory queue, and save browser-local playlists while navigating other views.
- `Config`: manage provider rows, endpoints, keys, and explicitly active LLM/TTS models. Save refreshes the matching model catalog without restart or blocking unrelated storage writes.

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
- `OpenCode Go`
  - Built-in LLM provider using the [OpenCode Go API](https://opencode.ai/docs/go/)
  - Reuses the `opencode-go` API credential from the current user's OpenCode login
  - `OPENCODE_GO_API_KEY` overrides the login credential when set
  - Discovers models from `https://opencode.ai/zen/go/v1/models`; MiniMax and Qwen use `/messages`, while the remaining Go models use `/chat/completions`
  - Models remain inactive until selected in Config and cannot be enabled as TTS models; newly discovered IDs stay disabled until their API protocol is mapped
- `Chatterbox`
  - User-supplied OpenAI-compatible base URL
  - Model discovery via `/models`, voice discovery via `/voices`, and TTS via `/audio/speech`
  - The service must be running before refresh, preview, or rendering; discovery lists metadata without loading model weights
  - API key is optional for local servers
  - Per-speaker exaggeration, CFG weight, and temperature controls are sent with TTS requests

Config discovers models but exposes only models explicitly activated as LLM, TTS, or both. Saved profile models are activated during legacy migration so existing profiles keep working. Custom compatible connections may omit API keys for local unauthenticated servers.

Saved API keys can be staged for removal with `Clear saved key`, then deleted by `Save config`. Blank key fields continue to mean “keep existing.”

## Language Rules

- Episode Format language is source of truth for transcript generation.
- Editable prompts no longer need language wording.
- Server injects hidden language rule during outline and transcript generation.
- TTS previews and renders always use the saved Episode Format language.
- MiMo preset TTS remains limited to English and Chinese.

## Duration Rules

- Generated transcripts require at least 125 spoken words per target minute.
- Short imported or edited transcripts remain renderable after a warning and confirmation.
- Transcripts with fewer segments than configured remain renderable after a warning; excess segments are rejected.
- Rendering inserts cue-aware pauses and publishes short MP3s with a warning when they are below 90% of target duration.
- Rendering uses the saved transcript directly and preserves only cue syntax supported by each selected TTS model.
- Failed rerenders preserve the last successful MP3 when it was still valid before the job.

## Storage

- `data/profiles.json`: speaker profiles and episode profiles
- `data/plans/index.json`: content plan summaries
- `data/plans/*.json`: editable content plans and creation links
- `data/config.json`: non-secret provider and compatible connection metadata
- `.env`: API keys and base URL values
- `data/episodes/*`: saved episodes, transcripts, audio, clip cache

Episodes store Speaker Profile and Episode Format snapshots. Later profile edits do not alter existing transcripts or renders; use **Apply latest profiles** (or save the episode draft) to intentionally refresh its snapshots.

Reviewed transcript text remains authoritative when generation instructions change. Refreshing snapshots invalidates audio when language, speaker mapping, TTS model, voice, style, accent, or Chatterbox tuning changes. Stale MP3 files stay hidden until a successful render replaces them.

On startup, obsolete outline/transcript JSON, concat manifests, temporary files, unused clip-cache entries, and any episode deletion already committed under a `.deleting` directory are removed. Corrupt episode metadata is listed as unavailable instead of silently disappearing; repair its `episode.json` before destructive profile or provider changes.

Keys stay server-side. The OpenCode Go login key is read at runtime and is never copied into this project. API responses return `hasApiKey` and a safe credential-source label, never raw secret values.

The server binds to loopback, rejects cross-origin writes, prevents framing, and supports HTTP byte ranges for MP3 playback.

Unsaved Config, Host, Format, episode, and transcript edits are protected across view and episode changes. Keyboard focus stays within open overlays; transcript tabs support arrow, Home, and End keys; reduced-motion preferences disable nonessential animation.

Player queues last for the current page session. Named playlists are stored in the current browser profile's `localStorage`; they are not included in server data backups.

OpenAI and compatible TTS voices are AI-generated. Disclose that fact in published episodes. This app generates podcast scripts; it does not transcribe uploaded audio.

## Background Jobs

Transcript generation and TTS rendering run through one local FIFO queue.

- `GET /api/jobs` exposes active and recent jobs, including transcripts followed by automatic TTS
- Activity shows recent jobs and in-app notifications
- Browser-local Transcript and TTS switches can send desktop success/failure alerts while the open app is unfocused
- Active jobs are marked interrupted after restart

## Verify

```powershell
npm test
```
