# Product
<!-- impeccable:product-schema 1 -->

## Platform

Web application running locally in the creator's browser.

## Users

Solo podcast creators who operate the complete workflow themselves, from the initial idea through rendered audio.

## Product Purpose

pod-god is a chat-first podcast production assistant. It helps one creator define a show, configure hosts and episode format, plan episodes, generate and review scripts, synthesize voices, render MP3s, and listen to the finished output. Success means moving from an idea to playable episodes without losing manual control.

## Positioning

The assistant conversationally orchestrates the end-to-end workflow while full production screens remain available for detailed work. Unlike a single-provider generator, pod-god preserves provider, model, voice, transcript, and rendering control.

## Operating Context

The creator connects text and TTS providers, supplies source material, builds a content plan, reviews assistant proposals, edits transcripts, previews voices, monitors background jobs, renders MP3s, and manages playback and playlists.

## Capabilities and Constraints

- Chat is the primary navigation and orchestration surface; production screens support focused work.
- Preserve every existing capability, with advanced provider, model, voice, and production controls progressively disclosed.
- Supports MiMo, ElevenLabs, OpenAI, OpenCode Go, Chatterbox, and custom OpenAI-compatible connections.
- Episodes preserve profile snapshots; scripts and audio remain explicit, reviewable production stages.
- The application is local-only. No multi-user collaboration or publishing integration is currently evidenced.
- Preserve working semantics, keyboard access, responsive behavior, status communication, and reduced-motion support through the redesign.

## Brand Commitments

- Product name: pod-god.
- Preserve the existing black, amber/yellow, green-success, and red-error color family.
- Use the familiar chat-plus-production-workspace pattern deliberately, executed at a high craft level rather than forced into an unfamiliar metaphor.
- Take tactile discipline from the Teenage Engineering TP-7: matte near-black surfaces, precise micro-labels, strong physical hierarchy, compact status displays, and oversized controls only where the action truly deserves them.
- Take digital finish from the Hermes Agent website: confident hierarchy, generous composition, authored visual moments, progressive numbered sequencing, and restrained chrome.
- Treat TP-7 and Hermes as quality bars, not templates: do not copy their assets, claims, layouts, or palettes.

## Evidence on Hand

- The existing application is implemented in `public/index.html` and `src/app.mjs`.
- The repository contains working provider integrations, end-to-end workflow logic, tests, and a pixel robot icon at `public/icon.png`.
- No customer, testimonial, benchmark, publishing, or collaboration claims are established; future design work must not fabricate them.

## Product Principles

- Conversation leads; screens deepen.
- Make production progress unmistakable.
- Hide infrastructure until it is needed without removing control.
- Keep AI changes reviewable and reversible.
- Make rendered audio feel like a meaningful completion state.
