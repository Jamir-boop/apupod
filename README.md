# apupod

apupod is a local podcast studio that your AI agent drives. Your agent (Claude Code, the ChatGPT desktop app, or OpenCode) writes the hosts, the series plan, and the scripts, and it calls apupod MCP tools to save them. apupod validates and stores the work, renders the audio with your TTS provider keys, and shows everything in a browser UI.

apupod makes no LLM calls. All text work runs on your agent subscription. apupod keeps the data, the UI, the TTS render pipeline (FFmpeg, clip cache, player), and an optional TypeSafe Jev check.

## The name

**apupod** (say "AH-poo-pod") joins the Quechua word *apu* and *pod*.

In the Andes, an *apu* is a "lord": the spirit of a mountain that watches over the place and the people below it. The name fits the design: your agent is the lord of the show and makes the decisions, and apupod keeps the show (its hosts, plans, scripts, and audio) safe in one place.

## Requirements

- Node.js 24 or later
- FFmpeg and FFprobe on `PATH` (for audio rendering)
- A key for at least one TTS provider (ElevenLabs, MiMo, OpenAI, Chatterbox, or an OpenAI-compatible TTS server)

## Install

apupod is not on npm yet. Install it from a clone:

```bash
git clone https://github.com/Jamir-boop/apupod.git
cd apupod
npm ci
```

Each harness starts the stdio bridge (`apupod mcp`). The bridge connects to the apupod daemon, or starts it in the background if it is not running. You do not need to start a server yourself.

The clone must contain `node_modules` (from `npm ci`), because the plugins run `bin/apupod.mjs` from it.

### Claude Code CLI and Claude desktop (Code tab)

This repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin, `apupod` (`.claude-plugin/plugin.json`, `.mcp.json`, `skills/`).

```bash
claude plugin marketplace add /path/to/apupod
claude plugin install apupod@apupod
```

In a session, `/plugin marketplace add /path/to/apupod` and `/plugin install apupod@apupod` do the same. The Claude desktop Code tab uses the same plugins. A marketplace added from a local path loads the plugin in place, so `git pull` and `npm ci` update it.

To open the UI in the Claude desktop browser pane, copy `.claude/launch.json` from this repository into your project's `.claude/` folder. Its `apupod` entry opens `http://127.0.0.1:4173` when the daemon runs. Its `apupod-serve` entry starts the daemon from this repository.

### ChatGPT desktop app and Codex CLI

This repository is also a portable Agent Plugins package (root `plugin.json`, `mcp.json`, `skills/`) with a repo marketplace at `.agents/plugins/marketplace.json`. The Codex CLI and Codex in the ChatGPT desktop app share `~/.codex/config.toml`, so one setup serves both.

```bash
codex plugin marketplace add /path/to/apupod
codex plugin add apupod@apupod
```

You can also restart the ChatGPT desktop app and install `apupod` from the `apupod` source in the Plugins Directory. The plugin has a local (stdio) MCP server, so it runs only in the desktop app and the CLI, in local threads.

The install copies the whole plugin folder into `~/.codex/plugins/cache/`. Use a clean clone (with `node_modules`, but no `.env` or `data/`) so that no secrets or old data are copied. After you update the clone, install the plugin again: `codex plugin remove apupod@apupod`, then `codex plugin add apupod@apupod`.

### OpenCode CLI and app

Add the MCP server and the skills to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). Replace `/path/to/apupod` with the absolute path of your clone (also in `examples/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "apupod": {
        "type": "local",
        "command": ["node", "/path/to/apupod/bin/apupod.mjs", "mcp"]
      }
    }
  },
  "skills": ["/path/to/apupod/skills"]
}
```

The `skills` entry makes OpenCode find the four apupod skills. Use an absolute path: OpenCode resolves a relative path from its working directory, not from the config file. Instead of the `skills` entry, you can copy the `skills/apupod*` folders into `~/.config/opencode/skills/` or `~/.agents/skills/`.

OpenCode releases before the `mcp.servers` format put the server directly under `mcp` (`"mcp": {"apupod": {"type": "local", "command": [...], "enabled": true}}`).

## Keys

Set keys in the UI **Settings** view, or in the `.env` file in the config dir (written with mode `0600`). A variable in the process environment wins over the file. See `.env.example` for the names:

- TTS: `ELEVENLABS_API_KEY`, `MIMO_API_KEY` (and optional `MIMO_BASE_URL`), `OPENAI_API_KEY`, `CHATTERBOX_API_KEY` (optional for a local server), and one generated key per OpenAI-compatible TTS connection.
- `TYPESAFE_API_KEY` (optional): turns on the `jev_decide` check with the pinned model `jev-1.14.0`. apupod works without it.
- `PORT` (optional): the daemon port on `127.0.0.1`, default `4173`.

MCP tools never accept, return, or log key values. They report only `hasApiKey` flags.

## Data and config

apupod never depends on the current directory.

- Data dir: `$APUPOD_DATA_DIR`, else `$XDG_DATA_HOME/apupod`, else `~/.local/share/apupod`. It holds `profiles.json` (host profiles and Episode Formats), `plans/`, `knowledge/` (Markdown knowledge bases), `episodes/` (scripts, audio, clip cache), and `previews/` (voice previews, removed after one hour).
- Config dir: `$APUPOD_CONFIG_DIR`, else `$XDG_CONFIG_HOME/apupod`, else `~/.config/apupod`. It holds `config.json` (TTS connections, no secrets), `.env` (keys), `mcp-token` (the bridge bearer token), `daemon.json` (PID and URL of the running daemon), and `daemon.log`.

The `data/` folder in this repository is an archive of the old app. apupod does not read it.

## Workflow

Ask your agent for a podcast. The `apupod` skill guides it through these steps:

1. Save source material (optional): `add_knowledge`.
2. Design the hosts and voices: `save_host_profile` (skill `apupod-hosts`).
3. Save the show format (language, length): `save_episode_format`.
4. Plan the series and its episodes: `save_plan` (skill `apupod-plan`).
5. Create the episode drafts: `create_episodes`.
6. Write each script: `get_script_rules`, then `save_script` (skill `apupod-script`).
7. Render the audio: `render_audio`, then follow it with `get_job`.
8. Listen in the chat (where the host shows widgets) or in the UI Player.

Example prompts: "Use apupod to make a 3-episode podcast about the history of coffee, with two hosts." "Write and render the next apupod episode."

## Tools

| Tool | Does |
|---|---|
| `get_workspace` | Overview: host profiles, formats, knowledge bases, plans, episodes, TTS readiness, Jev availability, UI URL. Call it first. |
| `open_ui` | Returns the UI URL, optionally deep-linked to a view or an episode. |
| `list_tts_options` | Active TTS models, languages, cue capabilities, tuning ranges and defaults, and which providers have keys. |
| `list_voices` | Voices for a TTS provider or one active TTS model. |
| `save_host_profile` | Creates or updates a host profile with 1 to 4 speakers. |
| `delete_host_profile` | Deletes a host profile; formats and plans move to the first remaining profile. |
| `save_episode_format` | Creates or updates an Episode Format (name, description, hosts, language, target minutes). |
| `delete_episode_format` | Deletes an Episode Format that no episode or plan uses. |
| `add_knowledge` | Saves a Markdown knowledge base (at most 3 MiB). |
| `get_knowledge` | Reads a knowledge base in pages. |
| `delete_knowledge` | Deletes a knowledge base. |
| `save_plan` | Creates or updates a content plan with the planned episode list the agent wrote. |
| `get_plan` | Reads a content plan. |
| `delete_plan` | Deletes a content plan; its episodes stay. |
| `create_episodes` | Creates episode drafts from planned episodes, or one ad-hoc episode. |
| `get_episode` | Reads an episode with its script, status, render job, and audio URL. |
| `get_script_rules` | Everything the agent needs to write a valid script: speakers, segments, word targets, language, TTS cue rules, source. |
| `save_script` | Validates and saves the Markdown script; can also queue the render. |
| `render_audio` | Queues the TTS render of the saved script into an MP3. |
| `get_job` | Status and progress of a render job. |
| `list_jobs` | Recent render jobs and the active job. |
| `preview_voice` | Synthesizes up to 600 characters for one speaker and returns a WAV URL. |
| `rename_episode` | Renames an episode. |
| `delete_episode` | Deletes an episode with its script and audio. |
| `jev_decide` | Optional TypeSafe Jev check that picks configuration values only from the live workspace options. Saves nothing. |

## Widgets

Hosts that support MCP Apps show two in-chat widgets: `ui://apupod/workspace` (overview cards, from `get_workspace` and `open_ui`) and `ui://apupod/episode` (status, script stats, and an audio player, from `get_episode`, `save_script`, and `render_audio`). The widgets render only from the tool's structured result and load audio from the daemon URL. Every tool also returns a complete text result, so hosts without widgets lose nothing.

## The UI

Open `http://127.0.0.1:4173` (or run `apupod open` to print the URL). The UI shows the production list, hosts, format, script editor, TTS preview and render, player, activity, and Settings (TTS connections, the TypeSafe key, knowledge bases). You can make light edits there. The UI refreshes by itself when the agent changes data.

## Security

- The daemon binds to `127.0.0.1` only and accepts only local requests with a local `Host` header.
- `/mcp` needs `Authorization: Bearer <token>`, with the token from `mcp-token` in the config dir (mode `0600`). The stdio bridge sends it for you. `/mcp` rejects any foreign `Origin`.
- The REST API rejects cross-origin writes.
- Keys stay in the daemon. API and tool results return `hasApiKey` flags, never key values.

OpenAI and compatible TTS voices are AI-generated. Disclose this in published episodes.

## CLI

```text
apupod serve       Run the daemon (UI + REST + /mcp) in the foreground
apupod mcp         Run the stdio bridge (harnesses start this)
apupod open        Print the UI URL
apupod --version   Print the version
```

From a clone, run `node bin/apupod.mjs <command>`.

## Development

```bash
npm ci
npm test               # all tests (node --test)
node bin/apupod.mjs serve   # or: npm start
```

Use `APUPOD_DATA_DIR`, `APUPOD_CONFIG_DIR`, and `PORT` to run a second daemon with separate data. See `AGENTS.md` for the contribution rules.
