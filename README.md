# pod-god

Small local web app for building reviewed podcast transcripts and rendered audio. No Docker or DB.

## Requirements

- Node.js 24+
- FFmpeg and FFprobe on `PATH`
- Browser on same machine

## Start

```bash
cp .env.example .env
npm ci
npm start
```

Open `http://127.0.0.1:4173`.

The app depends on the official `openai` and `@anthropic-ai/sdk` packages, pinned in `package-lock.json`.
The SDKs add their own `User-Agent` and `X-Stainless-*` headers to each request. The app stops the SDKs from using the environment base URL, key, organization, project, `OPENAI_CUSTOM_HEADERS` or `ANTHROPIC_CUSTOM_HEADERS`; each connection uses only its configured URL and key.

## Development

Run with automatic environment loading:

```bash
npm run dev
```

`server.mjs` is the runtime entrypoint. The implementation lives in `src/app.mjs` and `src/defaults.mjs`; the root `app.mjs` and `defaults.mjs` are one-line re-export shims kept for existing imports.

## Views

The `Podcast Assistant` is a pane beside every view, not a view itself: describe a podcast in chat, upload optional Markdown, and review proposed hosts and formats before applying them.

- `Episodes` (`view-episodes`): create and run episode drafts, track job progress, open or delete saved episodes.
- `Hosts` (`view-speakers`): 1 to 4 speakers, default TTS model, and per-speaker voice, style, accent and tuning overrides.
- `Format` (`view-format`): name, description, language, target minutes, and the outline and transcript models with their reasoning effort.
- `Script` (`view-transcript`): open saved episodes, review provider/model cue rules, generate transcripts, and edit canonical text.
- `TTS Generator` (`view-tts`): preview speakers in the saved Episode Format language and render final MP3.
- `Player` (`view-player`): play rendered episodes, change playback speed, manage an in-memory queue, and save browser-local playlists while navigating other views.
- `Model Connections` (`view-config`): manage provider rows, endpoints, keys, and explicitly active LLM/TTS models. Save refreshes the matching model catalog without restart or blocking unrelated storage writes.

## Providers

- `MiMo`
  - Text generation via `chat/completions`
  - TTS via `mimo-v2.5-tts`
- `ElevenLabs`
  - TTS models from `/v1/models`
  - Voice browser from `/v2/voices`
  - Standard `eleven_v4` uses the existing per-turn speech endpoint. Activate it in Model Connections before use. Existing profiles keep their model choices.
  - v4 sends Stability and Similarity, plus optional seed and text normalization. It does not send Style, Speed, or Speaker boost. Hidden legacy values remain saved.
  - v4 preserves natural audio tags and rejects SSML. Requests stay within 10,000 characters, or a smaller advertised limit.
  - All ElevenLabs models use advertised request limits, with model defaults when no limit is returned. Long turns split at safe text boundaries, or fail if a safe split is not possible. Chunk audio combines before the turn pause.
  - Accent overrides cannot force a v4 accent. Cross-language speech uses a natural target-language accent. Preview important voices before rendering.
  - Native multi-speaker dialogue and v4 Turbo are deferred. Realtime-only models stay unavailable in this HTTP workflow.
  - [ElevenLabs v4 and prompting](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
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
- `ChatGPT plan`
  - Separate from the OpenAI API-key connection. It is disabled by default.
  - In Model Connections, use `Continue with ChatGPT`, allow plan usage, enable the provider, and activate models from that account's catalog.
  - Uses the public Responses API for eligible text requests. It does not provide TTS or read ChatGPT conversations, memories, or Codex credentials.
  - Each saved account has its own registration. Requests pin the selected account. Account changes or sign-out stop old requests instead of using a different account.
  - Queued ChatGPT transcript jobs pin the account when queued. An account change before execution stops the job instead of using the newly selected account.
  - Usage or access errors stop the request. There is no automatic API-key billing fallback. Use `Manage usage` or select another provider yourself.
  - Prompts and selected context go to OpenAI. Local storage does not mean offline inference.
  - This flow is for eligible local and open-source clients. Paid or remotely hosted distribution needs a separate access review. [Official local-app guide](https://developers.openai.com/siwc/token-sharing-open-source)
- `Jev configuration decisions`
  - Optional assistant decision layer using `TYPESAFE_API_KEY` and the pinned model `jev-1.13.0`. It is disabled by default and is not a script or TTS model.
  - Jev selects typed settings from valid model, language, profile, voice, and delivery-preset choices. The text model writes prose.
  - Host count is resolved before per-host decisions. Voice choices are specific to the selected provider and model. Unrelated saved tuning remains unchanged.
  - Low confidence or an unavailable service returns a visible question or warning, without letting the text model choose the configuration instead.
  - Review the decision receipt and use manual `Apply`. Apply rejects stale settings, changed accounts, inactive selected models, and invalid voice ownership. Older messages without receipts remain compatible.
  - Only a small current request, selected context, and recent chat history go to TypeSafe. The full knowledge base and credentials are not sent as decision state. [TypeSafe API](https://docs.typesafe.ai/api)
- `OpenAI Decisions`
  - Select OpenAI Decisions in Assistant configuration decisions. Uses the existing `OPENAI_API_KEY` with the pinned `gpt-6-luna` model and native `/v1/decisions` endpoint. No new secret is needed. URL overrides and ChatGPT OAuth tokens are not used.
  - This is billed API use, separate from a ChatGPT subscription. Changing the selected decision provider does not clear either provider's key. Blank key fields keep saved keys. The OpenAI connection owns the OpenAI key control; the TypeSafe field always owns the TypeSafe key.
  - Uses typed choices and predicates for intent, profile targets, field scope, and action suggestions. Named refusals, invalid answers, timeouts, or uncertainty stop the proposal. There is no automatic provider fallback or Decisions retry.
  - In Hosts, use `Suggest delivery setup` for the current unsaved draft. It sends full backstory, personality, voice direction, profile rules, episode language, and the request. It needs no text model. A role choice and five ordinal rubrics (energy, warmth, theatricality, pacing, restraint) map to supported delivery presets and a direction in the existing `style` field. The direction feeds the transcript prompt after Apply.
  - Delivery-only requests preserve host count, personas, voice, model, accent, language, and unrelated tuning. Numeric settings in a chat request require clarification instead of being replaced by inferred traits. Changed tuning in the current Hosts draft is kept.
  - Review trait evidence and the proposed direction, then press manual `Apply`. Apply saves the reviewed draft and direction. A changed saved source or a later draft edit requires a new suggestion. Other unsaved profile edits are kept. Script and audio generation still need explicit approval.
  - The `0.7` safety gate is **UNCALIBRATED**, not a proven accuracy estimate. Decision receipts include provider and model, but not credentials or input context. [Official Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)
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

New custom connections cannot use the reserved IDs `chatgpt`, `openai`, `opencode-go`, or `chatterbox`. Legacy connections with these IDs keep their saved references and custom routing. The matching built-in provider reports an ID conflict.

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
- Normalized WAV audio and cached WAV clips must contain at least one complete audio frame. Valid silence is allowed; empty or incomplete frame data is rejected.

## Storage

- `data/profiles.json`: speaker profiles and episode profiles
- `data/plans/index.json`: content plan summaries
- `data/plans/*.json`: editable content plans and creation links
- `data/config.json`: non-secret provider and compatible connection metadata
- `data/knowledge/index.json` and `data/knowledge/*.md`: uploaded Markdown knowledge bases
- `data/chat/*.json`: Podcast Assistant chat threads, capped at 200 messages each
- `.env`: API keys and base URL values, written `0600`
- `$XDG_CONFIG_HOME/pod-god/chatgpt` (default `~/.config/pod-god/chatgpt`): protected ChatGPT OAuth credentials and account registrations, outside this repository and podcast data backups
- `data/episodes/*`: saved episodes, transcripts, audio, clip cache

Episodes store Speaker Profile and Episode Format snapshots. Later profile edits do not alter existing transcripts or renders; use **Apply latest profiles** (or save the episode draft) to intentionally refresh its snapshots.

`PUT /api/plans/:id` accepts optional `expectedUpdatedAt`. A value that differs from the saved plan returns `409`. Existing clients can omit this field.

Reviewed transcript text remains authoritative when generation instructions change. Refreshing snapshots invalidates audio when effective TTS settings change. Ignored v4 controls, voice direction, and accent overrides do not invalidate v4 audio. Stale MP3 files stay hidden until a successful render replaces them.

On startup, obsolete outline/transcript JSON, concat manifests, temporary files, unused clip-cache entries, and any episode deletion already committed under a `.deleting` directory are removed. Corrupt episode metadata is listed as unavailable instead of silently disappearing; repair its `episode.json` before destructive profile or provider changes.

Keys stay server-side. The OpenCode Go login key is read at runtime and is never copied into this project. API responses return `hasApiKey` and a safe credential-source label, never raw secret values.

The server binds to loopback, rejects cross-origin writes, prevents framing, and supports HTTP byte ranges for MP3 playback.

ChatGPT account controls use `/api/chatgpt/status` and explicit POST actions for `signin`, `select`, `signout`, and `cancel`. Sign-in opens the official authorization page and a local callback. Status returns safe account and permission fields, not tokens. Closing the app closes the callback listener and releases credential-storage locks.

An interrupted ChatGPT sign-in can leave protected `sign-in-recovery.json` in the ChatGPT storage directory. Startup validates it and restores the last committed account state before removing the recovery file. Invalid or unsafe recovery data stops startup.

Unsaved Config, Host, Format, episode, and transcript edits are protected across view and episode changes. Keyboard focus stays within open overlays; transcript tabs support arrow, Home, and End keys; reduced-motion preferences disable nonessential animation.

Saves and background refreshes keep later editor drafts. Model option updates keep selected Format, knowledge-base, and Hosts values, including saved unavailable choices. Late episode, chat, and provider voice responses do not replace newer selections or voice catalogs. Host deletion keeps unrelated profile drafts; conflicting changes from another tab can still require a reload.

Player queues last for the current page session. Named playlists are stored in the current browser profile's `localStorage`; they are not included in server data backups. Playlist writes use Web Locks and read the latest list inside the lock. Without Web Locks, playlist writes are rejected; reading saved playlists and using the playback queue remain available.

OpenAI and compatible TTS voices are AI-generated. Disclose that fact in published episodes. This app generates podcast scripts; it does not transcribe uploaded audio.

## Background Jobs

Transcript generation and TTS rendering run through one local FIFO queue.

- `GET /api/jobs` exposes active and recent jobs, including transcripts followed by automatic TTS
- Activity shows recent jobs and in-app notifications
- Browser-local Transcript and TTS switches can send desktop success/failure alerts while the open app is unfocused
- Active jobs are marked interrupted after restart

## Verify

```bash
npm test
```
