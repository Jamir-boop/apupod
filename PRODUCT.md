# Product
<!-- impeccable:product-schema 1 -->

## Platform

Local daemon with a web UI in the creator's browser, driven by the creator's AI agent harness (Claude Code, the ChatGPT desktop app, OpenCode) through MCP tools and skills.

## Users

Solo podcast creators who operate the complete workflow themselves, from the initial idea through rendered audio.

## Product Purpose

apupod is an agent-driven podcast studio. The creator's own agent writes the hosts, the episode format, the plan, and the scripts, and saves them through apupod MCP tools. apupod validates and stores the work, synthesizes voices, renders MP3s, and plays the finished output. apupod makes no LLM calls. Success means moving from an idea to playable episodes without losing manual control.

## Positioning

The agent orchestrates the end-to-end workflow in its own chat, while the production screens remain available to view the work and make light edits. Unlike a single-provider generator, apupod preserves TTS provider, voice, script, and rendering control, and it uses the agent subscription the creator already has for all text work.

## Operating Context

The creator connects TTS providers, supplies source material, asks the agent for hosts, a plan, and scripts, reviews and edits the results, previews voices, monitors background jobs, renders MP3s, and manages playback and playlists.

## Capabilities and Constraints

- The agent harness is the primary orchestration surface; the UI shows the work, supports light edits, and refreshes when the agent changes data.
- Preserve every existing capability, with advanced provider, model, voice, and production controls progressively disclosed.
- Supports MiMo, ElevenLabs, OpenAI, Chatterbox, and custom OpenAI-compatible TTS connections. TypeSafe Jev is an optional decision check.
- Episodes preserve profile snapshots; scripts and audio remain explicit, reviewable production stages.
- The application is local-only. No multi-user collaboration or publishing integration is currently evidenced.
- Preserve working semantics, keyboard access, responsive behavior, status communication, and reduced-motion support through the redesign.

## Brand Commitments

- Product name: apupod (Quechua *apu*, the mountain lord that watches over a place, + *pod*).
- Use the user-selected Honey Graphite profile: dark graphite surfaces, warm content text, and small honey-gold cues. Status uses words, icons, and edge patterns instead of green or red.
- Use the familiar production-workspace pattern deliberately, executed at a high craft level rather than forced into an unfamiliar metaphor.
- Take tactile discipline from the Teenage Engineering TP-7: matte near-black surfaces, precise micro-labels, strong physical hierarchy, compact status displays, and oversized controls only where the action truly deserves them.
- Take digital finish from the Hermes Agent website: confident hierarchy, generous composition, authored visual moments, progressive numbered sequencing, and restrained chrome.
- Treat TP-7 and Hermes as quality bars, not templates: do not copy their assets, claims, layouts, or palettes.

## Evidence on Hand

- The application is implemented in `public/index.html` (UI), `src/app.mjs` (daemon), `src/mcp.mjs` (MCP tools), and `skills/` (agent workflow).
- The repository contains working provider integrations, end-to-end workflow logic, tests, and a pixel robot icon at `public/icon.png`.
- No customer, testimonial, benchmark, publishing, or collaboration claims are established; future design work must not fabricate them.

## Product Principles

- The agent leads; screens show and deepen.
- Make production progress unmistakable.
- Hide infrastructure until it is needed without removing control.
- Keep agent changes reviewable and reversible.
- Make rendered audio feel like a meaningful completion state.
