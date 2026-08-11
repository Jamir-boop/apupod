---
target: complete UI redesign while keeping colors
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-11T06-23-57Z
slug: public-index-html
---
Method: dual-agent (A: /root/impeccable_design_review · B: /root/impeccable_detector)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3 | Jobs, progress, toasts, disabled states, and counts are strong, but several workflow steps become complete from the same episode-exists condition. |
| 2 | Match System / Real World | 2 | Podcast language is good, but TTS, LLM, CFG weight, top-p, snapshots, URLs, and provider IDs leak into creative work. |
| 3 | User Control and Freedom | 2 | Confirmations and unsaved-change guards are solid; undo, batch control, and escape from repeated manual flows are limited. |
| 4 | Consistency and Standards | 3 | Components are cohesive, but Hosts/speakers/profiles, Format/Episode Format, and Audio/TTS Generator compete as terminology. |
| 5 | Error Prevention | 3 | Compatibility checks, native constraints, confirmations, preserved work, and staged key clearing prevent many failures. |
| 6 | Recognition Rather Than Recall | 2 | Workflow and inline hints help, but icon-heavy rows and cross-view model/profile dependencies demand memory. |
| 7 | Flexibility and Efficiency | 2 | Some keyboard behavior and persisted selections exist; there is no command path, global shortcut set, or batch production flow. |
| 8 | Aesthetic and Minimalist Design | 1 | Small system type, uniform borders, pills, compact grids, and many amber states give almost everything equal weight. |
| 9 | Error Recovery | 2 | Retry paths and detailed errors exist, but failures are detached from the failed control and rarely provide an in-place repair action. |
| 10 | Help and Documentation | 2 | Inline hints and provider links exist, but help is fragmented and organized around implementation rather than creator tasks. |
| **Total** | | **22/40** | **Acceptable; major redesign warranted** |

## Design Specificity Verdict

**LLM assessment:** Functionally specific, visually interchangeable. Podcast planning, voices, episode stages, script generation, TTS jobs, and the persistent player clearly belong to pod-god. The visual system remains a generic developer/admin console: 14px system type, dense bordered rectangles, tiny controls, and amber used for nearly every kind of emphasis. The pixel robot is distinctive but too small and isolated to create a product language. The strongest replacement direction is a restrained broadcast-production console: season rail, waveform/sequencer motifs, voice audition cards, episode “tapes,” and an authored completion moment, while preserving the black/amber/green/red identity.

**Deterministic scan:** One warning in `public/index.html:275`: `layout-transition` flags animation of `max-height` and `padding` on `.chat-controls-panel`. This is a real match, though the 180ms compact-panel transition makes it a polish issue rather than a release blocker. Prefer opacity/transform or a grid-row reveal. No false positives were identified.

**Visual overlays:** No browser automation or mutable DOM surface was exposed, so no reliable user-visible overlay was created. The fallback evidence is the successful CLI detector plus direct source inspection.

## Overall Impression

The product has a serious workflow engine hiding inside a settings-console shell. Its next design should make production—not configuration—the dominant experience. Provider complexity should become readiness infrastructure, chat should become contextual assistance, and the completed episode should feel like a real artifact rather than another successful job row.

## What’s Working

- The workflow skeleton is strong: explicit stages, counts, a next-step CTA, and episode-level script/audio status create real production structure.
- Safety and feedback are thoughtful: unsaved-change guards, destructive confirmations, compatibility validation, job progress, retry paths, persistent notifications, and preserved audio reduce fear.
- Accessibility foundations are above average: labels, live regions, focus trapping, keyboard transcript tabs, inert overlays, and reduced-motion support provide a useful base for the redesign.

## Priority Issues

### [P1] Workflow state is crowded and semantically unreliable

**Why it matters:** Users face roughly 9–10 top-level destinations while the first setup stages can appear complete from the same episode-exists signal. Navigation communicates confidence the underlying state has not earned.

**Fix:** Separate **Studio readiness** (Connections, Hosts, Format) from **Production** (Idea, Episodes, Scripts, Audio, Player). Compute readiness from real saved state, collapse completed setup, and keep one dominant “Continue production” action.

**Suggested command:** `$impeccable shape`

### [P1] Every surface behaves like an expert settings panel

**Why it matters:** Creative work is interrupted by provider infrastructure. Hosts can expose identity, biography, model, voice, accent, and many provider-specific tuning controls at once; Config exposes multiple providers and model activation before users understand the workflow.

**Fix:** Make the default layer task-oriented: host identity, voice audition, personality, and delivery. Move model overrides and synthesis tuning into Advanced. Convert Config into provider readiness cards with one connect/repair action, recommended defaults, and technical details behind disclosure.

**Suggested command:** `$impeccable distill`

### [P1] Visual hierarchy cannot carry the workflow’s complexity

**Why it matters:** Small headings, compact paddings, identical boxes, and many bordered controls make primary work, metadata, setup, and status feel equally important.

**Fix:** Preserve the palette but rebuild hierarchy: stronger stage titles, a generous task canvas, a quiet utility rail, fewer enclosing borders, larger episode and host objects, and one solid-amber action per region. Reserve green/red for outcomes and use neutral/outline treatments for secondary states.

**Suggested command:** `$impeccable layout`

### [P2] The interface underuses its sonic identity

**Why it matters:** Nothing beyond vocabulary expresses voices, pacing, episodes, sound, or production, so the app could be restyled into an unrelated AI admin tool without structural change.

**Fix:** Develop the pixel robot into a restrained broadcast-console identity. Use waveform/sequencer progress, host voice cards, episode tape objects, milestone ticks, and a completion state centered on the rendered show. Keep the existing colors unchanged.

**Suggested command:** `$impeccable bolder`

### [P2] Keyboard, focus, error placement, and mobile ergonomics stop short

**Why it matters:** Icon buttons are approximately 30px, focus styling misses download links and several summaries, no skip link bypasses the workflow, and detached errors make keyboard and low-vision recovery harder.

**Fix:** Use 44px touch targets on compact layouts, style every focusable element, add “Skip to workspace,” associate errors with their source, make critical failures assertive, and provide an adjacent repair action.

**Suggested command:** `$impeccable audit`

## Cognitive Load

Seven of eight checks fail: single focus, chunking, visual hierarchy, one thing at a time, minimal choices, working memory, and progressive disclosure. Grouping passes because panels, fieldsets, details, and provider cards generally keep related controls together.

Decision points beyond working-memory limits include the 9–10-item global navigation, the roughly 11-part Script workspace, seven playlist-management choices, the model dialog with eight control types plus a long checklist, and the Hosts editor with profile actions plus 8–14 conditional fields.

## Emotional Journey

- **Entry:** Chat is an inviting start, but an unconfigured text model can block the first message before the user understands Config.
- **Orientation:** The workflow and next-step card reassure, but inaccurate completion semantics erode trust.
- **Creation:** Reviewable assistant proposals and “Apply & continue” are the emotional high point.
- **Waiting:** Jobs, activity history, alerts, and persistent playback reassure during slow generation.
- **Failure:** Detached toast/activity errors report failure without consistently placing the remedy at its source.
- **Completion:** The Player works, but there is no authored episode artifact, season payoff, or “ready to publish” peak.

## Persona Red Flags

### Alex — Power user

- No global shortcuts, command palette, or batch “generate remaining” action.
- Playlist management exposes five adjacent icon actions whose meanings must be remembered.
- Repeated Hosts, Format, Draft, Transcript, and Guidance saves slow expert flow.
- Setup-to-production cannot reliably complete in under a minute unless defaults and connections are already ready.

### Jordan — First-timer

- The app asks for a podcast description before clearly explaining that a configured text model is required.
- Hosts and Format can look complete without being reviewed.
- TTS, LLM, reasoning effort, CFG weight, top-p, snapshots, and provider IDs lack plain-language framing.
- Field-level hints exist, but the system never explains the core mental model: connections supply models, hosts supply voices, formats supply writing rules, and episodes freeze both.

### Sam — accessibility-dependent user

- Semantic labels and overlay focus management are strong foundations.
- There is no skip-to-workspace link.
- Focus-visible styling omits download links and several expandable summaries.
- Compact icon controls create motor-access problems.
- Detached polite notifications are weaker than inline, associated error recovery.

## Minor Observations

- The visible brand hierarchy is weak; the logo and title are too small to anchor the product.
- Amber currently means primary, selected, current, warning, loading, code, and model type.
- `h3` is the same size as body text.
- Repeated 1px borders create a spreadsheet/settings-console texture.
- Nested scrolling under `body { overflow: hidden; }` may disorient at 200% zoom.
- Mobile converts workflow navigation into a long horizontal control strip.
- Empty states usually name absence but rarely offer the repair action in place.
- Replace the chat control transition of `max-height` and `padding` with a compositor-friendly reveal.

## Questions to Consider

- Is pod-god a production studio with chat assistance, or a chat that happens to orchestrate production?
- Could provider/model setup become a readiness checkpoint that disappears after success?
- Should a season be produced as a batch with exceptions opened for editing?
- What should the user feel when the first MP3 completes, and what visible artifact proves the show is real?
- Can the pixel robot, waveform, and episode tape become the ownable identity while every current color remains unchanged?
