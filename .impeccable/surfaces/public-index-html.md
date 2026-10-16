---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# pod-god application workspace

## Scope and mode

- Primary target: `public/index.html`; Operate surface for one solo podcast creator.
- Job: move from idea to finished audio through a chat-first assistant while retaining direct access to every production control.
- Primary action: continue the current production step from the conversation.
- Constraints: preserve all existing IDs, capabilities, state handling, accessibility, status meaning, and desktop/mobile operation.

## Shipped direction

- Theme: user-selected [Honey Graphite](https://github.com/Jamir-boop/amber-black/blob/main/style-guides/honey-graphite.md), with all 16 exact roles on the owned HTML root. The theme retains the approved composition, fonts, spacing, and geometry.
- State colors share honey gold. Words, checkmarks, distinct markers, and dashed or dotted edges retain success, warning, error, and destructive meaning. Selected rows stay dark; character selection uses gold with dark ink.
- Browser-owned audio chrome follows the dark color scheme. The existing artwork and authored content retain their colors.
- Approved comp: `.impeccable/mocks/comp-c-focus-canvas-drawer.webp`.
- Thesis: conversation is the studio; production tools appear beside it instead of replacing it.
- Composition: a 112px icon-and-label mode rail and dominant chat canvas occupy the flexible workspace; one 420–560px contextual production drawer occupies the right; a 64px tape-counter progress header spans both; the 72px transport persists below the active workspace.
- Memorable moment: the assistant proposes the next production artifact in the conversation while the relevant editor opens beside it, keeping creation and control in one frame.
- Chat focus may fold the production drawer and reclaim the full canvas. Activity remains a temporary right overlay rather than a third persistent column.
- Illustrative copy, metrics, project state, waveform data, and generated form values from the comp are not product data.

## Route strategy

- The header binds project identity, a TP-7-inspired current-stage counter, the connected production track, and job status into one scan line.
- The rail provides Chat, Production, Player, Activity, and Settings modes. Workflow substeps live in the progress header instead of duplicating rail navigation.
- Chat owns the primary canvas, including history, the authored lead, assistant proposals, the next-step callout, controls, upload, and composer.
- Exactly one selected production view acts as the contextual drawer. Its header, local tabs, close action, and independently scrolling body stay visible and operable.
- Advanced provider and episode controls use native disclosure. Values and labels come from existing application state.
- The persistent transport uses the real audio state and a restrained CSS seek track; it does not fabricate waveform amplitude.

## Visible ingredient inventory

| Commitment | Medium | Shipped behavior |
| --- | --- | --- |
| Project title, tape-counter stage progress, and job state | Semantic HTML + application state | Real project and `assistantProgress` data populate the shared header; the selected view and current production stage remain distinct states. |
| Chat, Production, Player, Activity, Settings | Semantic navigation + existing SVG symbols | A vertical 112px rail becomes a horizontal strip, then a fixed five-mode bottom strip. |
| Dominant chat canvas and composer | Existing semantic HTML/CSS | History, model, effort, knowledge base, upload, assistant actions, and proposal review remain intact. |
| Contextual production drawer | Existing views + CSS grid | One current view occupies the 420–560px right region and can be closed or folded away. |
| Activity | Existing notifications and jobs | Opens as a shadowed overlay with unread/error state on its rail control. |
| Persistent transport | Existing audio state + semantic controls | Remains reachable at desktop and mobile widths without inventing waveform data. |
| Production details | Native `details` / `summary` and existing fields | Infrastructure remains available through progressive disclosure. |

## Responsive contract

- Above 1200px: shared 64px header, 112px rail, flexible chat canvas, 34vw drawer clamped to 420–560px, and transport aligned between rail and drawer.
- 1025–1200px: the drawer fixes at 420px; the chat canvas keeps the remaining width.
- 821–1024px: regions stack; the mode rail becomes a compact horizontal workflow strip; chat opens as a full-screen layer; the selected production view owns the remaining height.
- 820px and below: project identity and the current tape counter share a 58px header; the complete six-stage track opens below it on demand without changing layout height; the five modes become a fixed bottom strip; chat and production each use the full content width; transport remains above or alongside the bottom navigation without covering primary actions.
- Reduced-motion preferences collapse animations and smooth scrolling to effectively instant state changes.

## Finish disposition

- The earlier composition review recorded **PASS** before Honey Graphite adoption. It is not evidence for the new theme.
- Final Honey Graphite disposition: **SHIP**. No material findings remain from this review.
- Review covered the exact theme, desktop (1280px) and mobile (390px) snapshots, keyboard focus, saved states, and error states.
- Activity notification and job summaries use an inset focus outline (-4px offset). The final focus image shows all four sides inside the dashed error boundary.
- Existing font-size advisories remain. Existing fonts and sizes were preserved.
- This review does not claim full WCAG conformance, live-provider validation, or cross-browser coverage.

## Unresolved decisions

- Real waveform visualization remains intentionally deferred until the backend exposes waveform or amplitude data.
