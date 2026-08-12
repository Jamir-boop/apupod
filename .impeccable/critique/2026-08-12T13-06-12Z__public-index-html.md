---
target: current style across all views
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-12T13-06-12Z
slug: public-index-html
---
# Impeccable critique: pod-god application workspace

Method: dual-agent (A: `/root/design_review` · B: `/root/detector_evidence`)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3/4 | Strong stage/job/save states; Activity rows are clipped and weakly structured. |
| 2 | Match System / Real World | 3/4 | Podcast stages feel natural; TTS, LLM, CFG, raw model IDs, and `saved/unavailable` leak infrastructure language. |
| 3 | User Control and Freedom | 2/4 | Fold/focus/close controls exist; mobile navigation changes the hidden view behind modal Chat. |
| 4 | Consistency and Standards | 2/4 | Strong macro system; focused active tabs become amber-on-amber and Hosts can show contradictory profile identity. |
| 5 | Error Prevention | 2/4 | Disabled actions and confirmations help; incompatible saved models remain selected without a singular repair path. |
| 6 | Recognition Rather Than Recall | 3/4 | Labels and stage markers help; icon-only row actions and provider terminology still require learned meaning. |
| 7 | Flexibility and Efficiency | 2/4 | Direct navigation and widened production help; repetitive episode/player work lacks accelerators. |
| 8 | Aesthetic and Minimalist Design | 2/4 | The shell is disciplined; Episodes, Hosts, Player, and Settings are dense while Chat is underused. |
| 9 | Error Recovery | 2/4 | Errors are visible, but clipped Activity data and provider failures do not lead to one clear recovery action. |
| 10 | Help and Documentation | 2/4 | Inline help exists but is fragmented and technical rather than task-oriented. |
| **Total** | | **23/40** | **Acceptable: strong authored foundation, significant state and hierarchy fixes needed.** |

## Design Specificity Verdict

The shell is unmistakably pod-god. The 112px instrument rail, TP-7-inspired tape counter, joined matte planes, scarce signal colors, dominant conversation, contextual production region, and persistent transport form a coherent product-specific composition. It does not look interchangeable with generic SaaS.

Specificity weakens inside the production views. Episodes, Hosts, Format, Script, Player, and Settings often fall back to conventional bordered form rows, repeated icon toolbars, and dense provider metadata. The central thesis also weakens once a project has data: the flagship conversation canvas remains mostly empty while the production view does the meaningful work.

The deterministic scan found 55 advisories in `public/index.html`: 48 undocumented font-size values and 7 undocumented color values. Most 12–14px sizes are reasonable operational typography; the 9px and repeated 11px labels are materially small. Most color findings are intentional interaction ramps or dark-amber states, including one color explicitly documented in DESIGN.md, so they are primarily token-documentation drift rather than visual defects.

No reliable browser overlay was produced. The browser evaluation surface was read-only, so mutable script injection failed; screenshots, DOM snapshots, computed styles, geometry, overflow measurements, and console evidence were used instead.

## Overall Impression

This is a compelling product shell with a real point of view. Its single biggest opportunity is to make state behavior and production hierarchy as intentional as the matte-black instrument styling. Right now the interface looks more resolved than it behaves.

## What's Working

- The macro composition is excellent: rail, conversation, production view, progress header, and transport have clear ownership without floating-card clutter.
- Signal colors are disciplined: amber means current/next, green means ready/completed, and red means failure/destruction.
- Responsive architecture is fundamentally strong: mobile gives one surface useful width, preserves touch targets, and places navigation in the thumb zone.

## Cognitive Load

Moderate-to-high in production views, with failures in chunking, minimal choices, and one-thing-at-a-time focus.

- The header exposes 6 stages and the rail 5 global modes.
- Each Episode row can expose host selection, two status signals, and four actions.
- Hosts combines provider health, profile CRUD, speaker navigation, model selection, and voice controls in one scroll.
- Format exposes roughly 7–9 decisions without meaningful sub-grouping.
- Settings presents 5 provider states plus custom connections and knowledge-base management.
- Player combines item actions, playlist actions, a view transport, and the persistent transport.

## Emotional Journey

The opening is confident: the project title, tape counter, Next Step block, and amber action create direction. The valley arrives when an in-progress project still shows a nearly empty conversation canvas asking the creator to describe the podcast, despite known episodes, scripts, renders, and provider failures.

High-stakes provider errors are visible but not reassuring because they do not collapse into one clear repair action. The ending is also weak: rendered artifacts can exist while both transports say “No episode loaded,” so successful production does not culminate in a satisfying listen-ready moment.

## Priority Issues

### [P1] Global state can become contradictory on mobile

**Why it matters:** Production or Settings can be selected behind the modal Chat while Chat remains open and active. Closing Chat reveals an unexpected destination and violates the one-active-mode mental model.

**Fix:** Close Chat before switching global modes, or make the bottom navigation inert/hidden while Chat is modal. Maintain exactly one active mode.

**Suggested command:** `$impeccable harden`

### [P1] Active transcript tabs become unreadable

**Why it matters:** Script and Prompt & Cues can compute to amber text on an amber background after focus/interaction, erasing the selected label on desktop and mobile.

**Fix:** Exclude tab buttons from the global filled active/hover rule. Keep tabs transparent with amber text/underline and an independent focus outline.

**Suggested command:** `$impeccable polish`

### [P1] Hosts can display two profile identities simultaneously

**Why it matters:** The selector can name “Serena & Diego — Fable 5 Prompting” while the loaded name, speaker navigation, and editable content say “Charlie — Fable 5 Prompting.” Users cannot safely know which profile they are editing or saving.

**Fix:** Make profile selection the single source of truth and render the form only after that profile is loaded; show an explicit loading state during transitions.

**Suggested command:** `$impeccable harden`

### [P1] Conversation does not reflect the project it supposedly leads

**Why it matters:** With episodes, scripts, renders, and provider errors already present, the largest canvas still says “Describe the podcast you want.” This undermines “conversation is the studio” and makes the signature surface feel dormant.

**Fix:** Derive a concise factual handoff from existing state: what is complete, the current blocker, and one next action. Do not fabricate conversation or metrics.

**Suggested command:** `$impeccable onboard`

### [P2] Production density and completion states need stronger hierarchy

**Why it matters:** Episodes, Hosts, Settings, and Player exceed comfortable scan density, while Activity clips job labels and completed audio lacks a rewarding listen-ready end state.

**Fix:** Give each row one state-dependent primary action; move secondary actions and advanced parameters into native disclosure or a compact overflow menu. Structure Activity as `status · artifact · time` with open/retry actions. Promote the latest rendered episode into a clear Play completion callout.

**Suggested command:** `$impeccable distill`

## Persona Red Flags

**Alex, power user:** Five-episode management is one row at a time, common episode and playlist work lacks visible accelerators, and widened production clips project/rail context. Alex will tolerate density but resent repetition.

**Jordan, first-timer:** TTS, LLM, raw model IDs, `saved/unavailable`, and CFG weight appear without task framing. Contradictory Hosts identity and mobile Chat state leave Jordan unsure what will be saved or what to repair.

**Sam, keyboard/low-vision user:** Focus outlines and semantic labels are generally good, but focused transcript tabs lose all contrast. Tiny 9–11px mono labels and clipped Activity rows make scanning unnecessarily difficult.

## Minor Observations

- The expanded mobile stage track overlaps the active view header by 56px instead of pushing it down.
- Widened production makes the rail/header context feel accidentally clipped rather than intentionally compact.
- Activity job buttons overflow their available width; measured scroll widths reached 354px and 452px inside a 318px content width.
- Settings repeats provider state in both its summary strip and provider rows.
- TTS and Player empty states are functional but visually inert and leave large unused regions.
- Download links surfaced with undefined URLs in the accessibility snapshot and need separate functional verification.
- The mobile transport plus bottom navigation reserves roughly 135px, materially reducing editing height.

## Questions to Consider

- If conversation is truly the studio, why does it know less about the current project than the production view beside it?
- Does every episode need four persistent actions, or can one state-dependent action carry the row?
- Should production complete on a library-management screen or on the finished episode ready to play?
- Is Settings organized around providers because creators think in providers, or because the implementation does?

## Coverage

Desktop and mobile inspection covered Chat, Episodes, Hosts, Format, Script, Prompt & Cues, TTS, Player, Settings, Activity, split layout, widened production, chat focus, expanded mobile progress, and available empty/error/status states. Populated transcript editing, successful TTS render progress, expanded connection forms, destructive confirmations, and injected network failures were not exercised because they require state mutation or external operations beyond this read-only critique.
