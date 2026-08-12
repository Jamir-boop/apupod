---
name: pod-god
description: A tactile, conversation-led production studio for turning podcast ideas into finished audio.
colors:
  studio-black: "#000000"
  rail-black: "#080808"
  canvas-black: "#0C0C0C"
  control-black: "#161616"
  warm-white: "#FFFFFF"
  quiet-gray: "#9A9A9A"
  disabled-gray: "#565656"
  signal-amber: "#FFB900"
  signal-amber-hover: "#CC9500"
  signal-amber-subtle: "#15120A"
  signal-amber-subtle-border: "#4D3900"
  complete-green: "#35C46A"
  failure-red: "#EF5B5B"
  failure-red-border: "#8F3434"
  failure-red-surface: "#220B0B"
  quiet-seam: "#242424"
  strong-seam: "#414141"
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
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.studio-black}"
    rounded: "{rounded.control}"
    padding: "6px 16px"
    height: "40px"
  button-neutral:
    backgroundColor: "{colors.control-black}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "38px"
  button-danger:
    backgroundColor: "#220B0B"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "38px"
  field:
    backgroundColor: "{colors.rail-black}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
    height: "38px"
---

# Design System: pod-god

## Overview

**Creative North Star: "Conversation is the Studio"**

pod-god feels like a precise production instrument rather than a generic dashboard. Matte near-black planes join into one workspace; warm white type carries the content; amber, green, and red behave like scarce hardware signals. The hierarchy is confident and spacious around the conversation, then compact and exact inside production controls.

Interaction keeps the creator oriented. Conversation remains the primary canvas, production tools appear contextually, progress is explicit, and advanced infrastructure stays behind disclosure until needed. Motion is brief and functional: it explains a drawer, fold, loading state, or next action, and respects reduced-motion preferences.

**Key Characteristics:**

- Matte, joined planes with quiet seams instead of floating card stacks.
- One dominant amber action or current-state signal per context.
- Large humanist conversation type paired with compact uppercase mono status labels.
- Low-radius tactile controls, native disclosure, and visible keyboard focus.
- Green means completed or ready; red means failed or destructive.

## Colors

The palette is nearly monochrome until an action, progress state, success, or failure deserves a signal.

### Primary

- **Signal Amber:** The sole action and current-state color. Use it for primary controls, active workflow position, focused controls, and in-progress status.

### Secondary

- **Complete Green:** Confirms ready, completed, and successfully rendered states.
- **Failure Red:** Marks errors, destructive actions, and failed jobs only.

### Neutral

- **Studio Black:** The outermost canvas and high-contrast text on amber.
- **Rail Black:** Navigation rails, headers, and the darkest inset controls.
- **Canvas Black:** The primary work surface.
- **Control Black:** Buttons, user messages, and raised control faces.
- **Warm White:** Primary content and labels.
- **Quiet Gray:** Secondary copy, hints, and inactive navigation.
- **Disabled Gray:** Unavailable actions and pending progress.
- **Quiet Seam / Strong Seam:** Structural dividers and interactive boundaries; use the stronger seam for fields, controls, and overlays.

**The Signal Rarity Rule.** Amber identifies the next action or current state; it does not decorate containers.

**The Semantic Status Rule.** Green is completion, red is failure or destruction, and neither color substitutes for general emphasis.

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

The system is flat by default. Tonal shifts and 1px seams establish depth between joined planes. Deep black shadows are reserved for true overlays such as activity drawers and transient notices; persistent regions and cards do not float. No glass, blur, or glow is part of the visual language.

### Shadow Vocabulary

- **Overlay:** A broad, opaque black shadow separates a temporary drawer from the workspace.
- **Transient Notice:** A compact downward black shadow lifts a toast above active content.

**The Flat-by-Default Rule.** If a seam or tonal step can explain the hierarchy, do not add a shadow.

## Shapes

Controls and content regions are square or gently eased at 2–3px. Joined planes and tab edges are square. Circular geometry is reserved for identity marks, status dots, transport controls, and intrinsically round range handles. Pill silhouettes are exceptional and only appropriate for compact status or metadata where the shape communicates a discrete token.

**The Instrument Edge Rule.** Low radii make controls feel machined and precise; large soft cards do not belong in this world.

## Components

### Buttons

- **Shape:** Tactile rectangular controls with gently eased corners; icon-only and text buttons share the same physical weight.
- **Primary:** Amber face with black content. Keep one primary action per immediate context.
- **Hover / Focus:** Neutral buttons invert to amber when the action deserves emphasis; every keyboard focus state uses a 2px amber outline with a 2px offset.
- **Danger:** Dark red face and red seam, brightening only on hover. Never use it as a general secondary action.

### Chips

- **Style:** Compact, low-radius metadata and state tokens on the darkest surface.
- **State:** Selected or active chips use amber; ready and error chips use their semantic colors. Rounded pills remain limited to status-oriented legacy cases.

### Cards / Containers

- **Corner Style:** Square to 2px corners.
- **Background:** Use tonal black steps with quiet seams; prefer joined regions and section dividers over nested cards.
- **Shadow Strategy:** Flat at rest; only true overlays receive shadow.
- **Internal Padding:** Compact controls use 8–16px; production sections use about 20–24px.

### Inputs / Fields

- **Style:** Dark inset field, strong neutral seam, low radius, warm white value, and quiet gray supporting copy.
- **Focus:** A visible amber outline supplements rather than replaces the field boundary.
- **Error / Disabled:** Error uses failure red with accompanying text; disabled states remain legible in disabled gray and keep their layout.

### Navigation

Navigation uses simple line icons plus short labels. Default items are quiet gray, hover becomes warm white on a slightly lighter black, and the selected item uses amber with a restrained dark-amber backing or underline. Labels remain available to assistive technology at every width.

### Progress and Status

Progress reads like a tape counter, not a decorative chart: the current stage and position lead in compact mono type, while the connected stage track supports orientation. Completed steps and connectors are green, the current step is amber, pending steps are disabled gray, and job state uses compact uppercase mono labels. On narrow screens the current counter remains visible and discloses the complete track on demand. Values always come from real application state.

### Contextual Disclosure

Use native disclosure for advanced settings and provider detail. A contextual tool region should explain what is open, keep its close action obvious, and never sever the creator from the production stage that opened it.

## Do's and Don'ts

### Do:

- **Do** let conversation lead and reveal production controls in context.
- **Do** use neutral seams and tonal black steps to organize dense work.
- **Do** reserve amber for the current state, visible focus, and the next meaningful action.
- **Do** preserve semantic status colors, keyboard operation, native disclosure, and reduced-motion behavior.
- **Do** keep generated changes, progress, and completion states explicit and reviewable.

### Don't:

- **Don't** turn every section into a rounded floating card.
- **Don't** outline every container in amber or use glow as decoration.
- **Don't** invent waveform, progress, collaboration, or publishing data.
- **Don't** hide advanced control permanently; disclose it when relevant.
- **Don't** use motion without a state change to explain.
