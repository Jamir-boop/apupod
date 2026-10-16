---
name: pod-god
description: A tactile, conversation-led production studio for turning podcast ideas into finished audio.
colors:
  bg: "#1E1E1D"
  surface: "#282725"
  field: "#191918"
  interaction: "#37332A"
  text: "#E6E2D8"
  muted: "#B6AFA1"
  disabled: "#B6AFA1"
  border: "#444036"
  control: "#8E8470"
  reference: "#CBAA60"
  accent: "#CBAA60"
  error: "#CBAA60"
  success: "#CBAA60"
  selection: "#CBAA60"
  selection-ink: "#191918"
  action-ink: "#191918"
typography:
  display:
    fontFamily: "system-ui, sans-serif"
    fontSize: "clamp(34px, 3.2vw, 48px)"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.045em"
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.01em"
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
rounded:
  joined: "0"
  control: "2px"
  composer: "3px"
  circular: "999px"
spacing:
  hairline: "4px"
  compact: "8px"
  control: "12px"
  section: "16px"
  panel: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.control}"
    padding: "6px 16px"
    height: "40px"
  button-neutral:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "38px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "38px"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
    height: "38px"
---

# Design System: pod-god

## Overview

**Creative North Star: "Conversation is the Studio"**

pod-god uses the user-selected Honey Graphite profile. Dark graphite surfaces form one workspace. Warm content text and small honey-gold cues retain the existing conversation-led hierarchy. Production controls stay compact.

Conversation remains the primary work surface. Production tools open in context, progress is explicit, and advanced controls stay behind disclosure. The theme changes owned UI colors, not layout, fonts, data, or actions. Existing motion owners and reduced-motion behavior remain in place.

Source: [Honey Graphite Style Guide](https://github.com/Jamir-boop/amber-black/blob/main/style-guides/honey-graphite.md), option 02, with source color targets dated 2026-10-09. Its written token specification is normative; the generated reference image is approximate. This record reflects the implementation in `public/index.html`. The existing `public/icon.png`, authored content, and browser-owned audio controls are not recolored.

**Key Characteristics:**

- Dark graphite surfaces with quiet decorative seams and clear control edges.
- Small honey-gold actions, references, focus outlines, and state markers.
- Existing system sans content and compact mono status labels.
- Low-radius controls, native disclosure, and visible keyboard focus.
- Words, icon shapes, and boundary patterns identify status; gold alone does not mean success.

## Colors

Use all 16 roles from the Honey Graphite profile above. The owned root is `html[data-theme="honey-graphite"]`, with `color-scheme: dark`. There is no light mode or light fallback.

### Primary

- **Honey Gold:** `accent`, `reference`, `error`, `success`, and `selection` share one color. Use their distinct roles for small primary actions, links, keyboard focus, status markers, and character selection.
- **Dark Ink:** `action-ink` and `selection-ink` provide text and glyph contrast on gold fills.

### Neutral

- **Graphite Canvas:** `bg` covers the main workspace.
- **Graphite Surface:** `surface` covers panels, rails, headers, menus, dialogs, and transport.
- **Inset Graphite:** `field` covers fields, the composer, and code surfaces.
- **Warm Interaction:** `interaction` covers hover, active neutral controls, and selected rows.
- **Warm Content:** `text` carries content, labels, and read-only values.
- **Quiet Text:** `muted` carries secondary text and placeholders at full opacity. `disabled` uses the same value only for disabled controls.
- **Decorative Seam:** `border` separates regions without a control-boundary claim.
- **Control Edge:** `control` identifies required interactive boundaries.

**The Signal Rarity Rule.** Keep resting surfaces dark and neutral. Use gold in small actions, references, focus outlines, and state markers.

**The Semantic Status Rule.** Gold alone does not identify a result. Keep state words and icons; use dashed error edges and dotted warning edges where implemented.

**The Boundary Ownership Rule.** Decorative seams use `border`; required control edges use `control`. Keyboard focus has a separate offset gold outline, and error edges remain visible.

Text, placeholders, action ink, and selection ink must meet 4.5:1 contrast. Required control edges and focus must meet 3:1 on adjacent surfaces. Opaque-pair calculations do not prove live contrast or WCAG conformance. Browser-owned audio chrome follows the browser's dark color scheme and retains native behavior.

Sidecar tonal ramps are preview metadata, not additional application tokens.

## Typography

**Display Font:** system-ui (with sans-serif fallback)  
**Body Font:** system-ui (with sans-serif fallback)  
**Label/Mono Font:** ui-monospace (with SFMono-Regular, Consolas, monospace fallbacks)

**Character:** The system sans is sturdy, direct, and readable at production density. Monospace appears only where compact status, metadata, or instrumentation benefits from mechanical precision.

### Hierarchy

- **Display:** Heavy and tightly tracked; reserved for the conversation lead and rare completion moments.
- **Title:** Compact surface and drawer headings with restrained negative tracking.
- **Body:** Dense but calm interface copy. Conversation messages may open to a more generous line-height and should remain comfortably readable.
- **Label:** Uppercase mono micro-labels with wide tracking for status, eyebrows, and compact instrumentation.

**The Two-Voice Rule.** Human-facing content uses the system sans; operational state uses mono. Do not introduce a decorative third voice.

## Layout

The system uses joined regions with visible ownership: navigation, conversation, contextual tools, and transport meet at quiet seams rather than floating independently. Conversation receives the most flexible width and breathing room; production surfaces are denser and scroll within their own region. Headers and persistent controls stay compact so the work remains dominant.

Spacing follows a tight 4px rhythm, with 8–16px inside controls and 20–24px between production sections. Responsive layouts preserve the same hierarchy: reduce simultaneous surfaces before reducing tap targets, and keep primary navigation and transport reachable without covering active work.

**The One-Work-Surface Rule.** On narrow screens, show the selected work surface at full useful width; do not squeeze chat and production side by side.

## Elevation & Depth

The system is flat by default. Graphite surface changes and 1px seams separate joined regions. Shadows use translucent `field` color for temporary overlays and notices. Persistent regions and cards do not float. No glass, blur, or glow is part of the visual language.

### Shadow Vocabulary

- **Overlay:** A broad graphite shadow separates a temporary drawer from the workspace.
- **Transient Notice:** A compact downward graphite shadow separates a toast from active content.

**The Flat-by-Default Rule.** If a seam or tonal step can explain the hierarchy, do not add a shadow.

## Shapes

Controls and content regions are square or gently eased at 2–3px. Joined planes and tab edges are square. Circular geometry is reserved for identity marks, status dots, transport controls, and intrinsically round range handles. Pill silhouettes are exceptional and only appropriate for compact status or metadata where the shape communicates a discrete token.

**The Instrument Edge Rule.** Low radii make controls feel machined and precise; large soft cards do not belong in this world.

## Components

### Buttons

- **Shape:** Tactile rectangular controls with gently eased corners; icon-only and text buttons share the same physical weight.
- **Primary:** Small gold face with dark action ink. Hover uses the dark interaction fill and content text, with a gold edge. The fill and ink change immediately to retain contrast. Keep one primary action per immediate context.
- **Hover / Focus:** Neutral buttons use the dark interaction fill and content text. Selected buttons retain a gold edge or underline. Keyboard focus uses a separate 2px gold outline with an offset.
- **Danger:** Dark surface, content text, and a dashed gold edge. Keep the destructive label or icon and the existing confirmation behavior.
- **Disabled:** Full-opacity disabled text on a dark surface. Keep native disabled semantics, with no action or hover feedback.

### Chips

- **Style:** Compact, low-radius metadata and state tokens on the graphite surface.
- **State:** Selected chips use the dark interaction fill and a gold edge. Ready states retain a checkmark; errors retain words, a distinct marker, and a dashed edge. Gold is shared, not a success code.

### Cards / Containers

- **Corner Style:** Square to 2px corners.
- **Background:** Use graphite surfaces with quiet seams; prefer joined regions and section dividers over nested cards.
- **Shadow Strategy:** Flat at rest; only true overlays receive shadow.
- **Internal Padding:** Compact controls use 8–16px; production sections use about 20–24px.

### Inputs / Fields

- **Style:** Inset graphite field, required control edge, low radius, warm content value, and full-opacity secondary text.
- **Focus:** A separate gold outline supplements the field boundary. The composer retains its larger outline offset.
- **Error / Disabled:** Invalid fields retain a dashed gold edge and error text during focus or selection. Disabled controls use full-opacity disabled text and retain their layout. Read-only values use normal content text.
- **Selection:** Selected characters use gold with dark selection ink. Selected rows use the dark interaction fill, content text, and an edge or native selected cue.

### Navigation

Navigation retains line icons and short labels. Default items use muted text. Hover and selected items use the dark interaction fill and content text. A gold edge or underline identifies the selected item. Labels remain available to assistive technology at every width.

### Progress and Status

Progress retains the tape-counter layout. Completed steps use checkmarks and gold connectors. The current step uses a filled marker; pending steps use muted text and empty markers. Job labels, icons, and edge patterns retain their meaning without green or red. On narrow screens the current counter remains visible and opens the complete track on demand; the hidden desktop counter stays available to assistive technology. The header job status (Ready, active, queued) stays visible at every width and updates whenever jobs change. Values always come from real application state.

Existing motion uses 120ms control feedback, 180ms control or menu changes, and 240ms panel entrances with `cubic-bezier(.16, 1, .3, 1)`. Loading markers and spinners retain their existing motion owners. The next-action cue is a static three-second outline, not a glow. Reduced-motion preferences retain effectively instant state changes. No navigation glide was added.

### Contextual Disclosure

Use native disclosure for advanced settings and provider detail. A contextual tool region should explain what is open, keep its close action obvious, and never sever the creator from the production stage that opened it.

Activity notification and job summaries, and the progress tape stages, use an inset gold focus outline (-4px offset). This keeps all four sides visible inside scrolling regions while dashed error boundaries remain visible.

## Do's and Don'ts

### Do:

- **Do** let conversation lead and reveal production controls in context.
- **Do** use graphite surfaces, decorative seams, and clear control edges to organize dense work.
- **Do** keep gold cues small and identify status with words, icons, and edge patterns.
- **Do** preserve keyboard operation, native disclosure, readable disabled text, and reduced-motion behavior.
- **Do** keep generated changes, progress, and completion states explicit and reviewable.

### Don't:

- **Don't** turn every section into a rounded floating card.
- **Don't** outline every container in amber or use glow as decoration.
- **Don't** add other accent hues, a light fallback, blanket filters, or forced SVG paint.
- **Don't** recolor artwork, authored content, or browser-owned audio controls.
- **Don't** invent waveform, progress, collaboration, or publishing data.
- **Don't** hide advanced control permanently; disclose it when relevant.
- **Don't** use motion without a state change to explain.
