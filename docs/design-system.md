# Tightbeam Chat design system

Tightbeam Chat's visual language is Clawline's "Organic Flow" design system applied to Chat's real widgets. This document is the contract for that adaptation. It says which Clawline values Chat uses, how each existing Chat widget looks in light and dark, where Chat departs from Clawline and why, and what the host platforms change. It describes appearance only. It adds no feature, behavior, component or package dependency.

Status: step 1 of the restyle. Nothing here is implemented yet. The restyle that applies it is planned and reviewed separately.

## Sources

| Source | Revision | What it supplies |
| --- | --- | --- |
| Clawline `docs/design-system/design-system.html` | `e1fc034a4d3daf0e9c18f7adde8dbb39da05be8f` | Palette, type, spacing, radii, shadows, glass, motion, do's and don'ts |
| Clawline `docs/design-system/demo.html` | same commit | The applied look: bubbles, glass input, surface |
| Tightbeam Chat `src/theme.css`, `src/style.css`, `src/messageAttachments.css`, components under `src/` | `19d721be87f54b3bfc7c71bd32e0c32033797786` | Every widget, state and token named below |
| Chat `tests/theme.test.ts` | same commit | The legibility and literal-ban invariants this design keeps |
| Tightbeam Tuner `ios/TightbeamTuner/ChatWebView.swift`, `ContentView.swift`, `TunerWindow.qml`, `TunerPalette.qml` | `1c4d515889462473f2d25a53ebab669aa5cf036f` | How the native host embeds and frames Chat |

The ask, quoted throughout as "the ask": "adopt the Clawline design system for Tightbeam Chat. Step 1, write Tightbeam Chat's own design system doc derived from Clawline." The ask names the Clawline highlights to carry: "light default plus a full dark palette, DM Sans, 4px spacing base, 28px squircle radii, warm top-lit shadows, subtle noise grain, terracotta and sage accents." It asks for (a) tokens, (b) a widget inventory from the code, (c) navigation, (d) departures with reasons and (e) platform constraints. Delivery ownership added: "No new components, features, behavior changes or dependencies beyond what the doc requires; any font or asset added must be justified in the doc."

## 1. Spirit

Clawline calls its philosophy organic modernism: "a high-end restaurant with warm lighting and curved booths, not a cabin in the woods. Sophisticated and contemporary, but never cold." A conversation "should feel like sitting across from someone in a comfortable space: unhurried, present, human. Not like operating a machine." Its color story is "home and arriving": your messages are sage ("home"), theirs arrive on a cream vessel with terracotta warmth. Glass marks "the threshold between thought and record." Shadows are top-lit and warm, the surface has paper grain, corners are large and soft with one sharp corner that points at the speaker.

Chat is a different product with the same spirit. Its "other" is an agent, not a friend. Its transcript mixes long agent answers, code, tables, activity rows and system captions. Its job is to be read for a long time and trusted. So the adaptation takes Clawline's materials (palette, type, surface, glass, light, shape) and applies them to Chat's existing structure. Where a Clawline idea needs new behavior or a new component, Chat does not adopt it in this step and section 6 says so.

Two Chat invariants outrank any Clawline value: every text pair stays at 4.5:1 or better, and nothing a reader needs is hidden or truncated. Clawline itself requires the first ("Primary text on surface: Meets WCAG AA (4.5:1 minimum)"). Chat's test suite enforces both today.

## 2. Terms

- **Clawline**: the design system at the source revision above. A "Clawline value" is a value printed in its `design-system.html` CSS or its specification tables.
- **Token**: a CSS custom property named `--tb-chat-*`, defined only in `src/theme.css`. Color literals stay banned in `src/style.css`, `examples/site.css` and `examples/hostComposer.css`.
- **Surface**: the page behind the transcript. Painted as Clawline's `--bg-surface-gradient`, top to bottom.
- **Human bubble / agent bubble**: Chat's `.tb-chat-bubble-human` and `.tb-chat-bubble-agent`. They play Clawline's "self" and "other" roles.
- **Glass**: a translucent, blurred layer over the transcript. Chat has two glass tokens and exactly three glass widgets: `composer-glass` for the composer shell and the scroll-to-latest pill, and `glass` for the attachment options popover. Only `text`, `placeholder` and the composer's own controls sit on glass; `muted` never does. Every other popup and dialog is opaque.
- **Elevation level**: one of the named shadow recipes in section 3.5.
- **Host**: the program that embeds Chat. Today that is Tuner on iOS (WKWebView), Tuner on desktop (Qt WebEngine), or a plain browser page served by the Chat server.
- **Host composer mode**: Chat with its own composer hidden because the host draws a native one (`.tb-chat-host-composer-hidden`).
- **Restyle**: the later change that edits CSS, tokens and assets to match this document.

## 3. Tokens

### 3.1 Color

Chat follows the system appearance (`prefers-color-scheme`). Light is the default. Each row shows the Clawline source and the Chat value. "Adjusted" means the Clawline color moved in lightness only, within its hue family, to meet a 4.5:1 pair Chat requires. Measured ratios are in section 9.

Surfaces:

| Token | Role in Chat | Clawline source | Light | Dark |
| --- | --- | --- | --- | --- |
| `background` | Surface, gradient top; base for mixes | `--bg-surface-gradient` stop 1 | `#F0EAE0` | `#1C1917` |
| `background-end` (new) | Surface, gradient bottom | `--bg-surface-gradient` stop 2 | `#E8E0D4` | `#141210` |
| `agent-surface` | Agent bubble; settings rows; close button | `--bg-bubble-other` stop 2 (`--bg-bubble-other-solid`) | `#FDF6EE` | `#292524` |
| `agent-surface-start` (new) | Agent bubble gradient top (light only) | `--bg-bubble-other` stop 1 | `#FFFDF9` | `#292524` (flat, as Clawline) |
| `human-surface` | Human bubble gradient start; latest-prompt card | `--bg-bubble-self` stop 1 | `#B8CEAF` | `#2D3B2A` |
| `human-surface-end` (new) | Human bubble gradient end | `--bg-bubble-self` stop 2 | `#C8D9C0` | `#243322` |
| `border` | Hairlines, table rules, pill outlines, local-send border | `--border-subtle` flattened onto the surface | `#E2DAD0` | `#33302E` |
| `code` | Inline code, table header | `--bg-surface-gradient` stop 2 (light); stop 2 (dark) | `#E8E0D4` | `#141210` |
| `code-block` (new) | Fenced code block, camera preview | Code block background `#1e1e1e` | `#1E1E1E` | `#1E1E1E` |
| `code-block-text` (new) | Plain text in a code block | `--ink` (dark) | `#E8E4E0` | `#E8E4E0` |

Text:

| Token | Role | Clawline source | Light | Dark |
| --- | --- | --- | --- | --- |
| `text` | Primary text | `--ink` / `--text-primary` | `#3D3429` | `#E8E4E0` |
| `muted` | Sender, time, captions, secondary rows | `--stone`, adjusted darker (light) and lighter (dark) | `#5B5046` | `#ADA39A` |
| `placeholder` | Composer placeholder | `--warm-brown` family, adjusted | `#584E45` | `#D9D2CA` |

Accents and activity inks:

| Token | Role | Clawline source | Light | Dark |
| --- | --- | --- | --- | --- |
| `accent` | Send disc, primary send action, focus ring, option hover tint | `--terracotta`, adjusted deeper in light | `#A3553E` | `#E07A5F` |
| `on-accent` | Glyph on the send disc and primary pill | `--cream` | `#F7F3EB` | `#1C1917` |
| `teak` | Inline code text, blockquote rule, orange pill | terracotta family, deep | `#744631` | `#D99A78` |
| `fjord` | Links, agent activity line, blue pill | none; Chat-only (section 6) | `#36505F` | `#9DB5C4` |
| `pill-purple` | Purple pill | none; Chat-only | `#6A4290` | `#C2AAE6` |
| `pill-indigo` (new) | Indigo pill (was `accent`) | none; Chat-only | `#4B4F8A` | `#AFB3EA` |
| `ok` | Ready dot, green pill, active-caption icon | `--sage`, adjusted deeper in light | `#405A3A` | `#8DB487` |
| `caution` | Rail lines, amber pill, caution caption, loading dot | `--muted-gold`, adjusted deeper | `#614A18` | `#D4B67E` |
| `transition` | Transition marker | `--warm-brown` family | `#655A4E` | `#B3A493` |
| `danger` | Errors, red pill, error dot | `--soft-coral` / terracotta family, deep | `#8E2F22` | `#F08C78` |
| `idle` | Idle status dot | `--stone`, as `muted` | `#5B5046` | `#ADA39A` |

Syntax colors sit on `code-block`, which is dark in both themes, so both themes share one set. They keep Chat's current dark-theme hues, which already pass on `#1E1E1E`:

| Token | Value (both themes) |
| --- | --- |
| `syntax-keyword` | `#C9A6EF` |
| `syntax-string` | `#9AD5A7` |
| `syntax-number` | `#F0B66E` |
| `syntax-comment` | `#B6ADA2` |
| `syntax-title` | `#8FCFF0` |

Glass, shadow and texture:

| Token | Clawline source | Light | Dark |
| --- | --- | --- | --- |
| `glass` | Liquid glass, neutral tint | `rgba(255,255,255,0.74)` | `rgba(44,40,37,0.74)` |
| `composer-glass` | Liquid glass, neutral tint | `rgba(255,255,255,0.94)` | `rgba(44,40,37,0.94)` |
| `glass-edge` | Glass border, white at 60% / 12% | `rgba(255,255,255,0.60)` | `rgba(255,255,255,0.12)` |
| `shadow` | Shadow color `rgba(60,45,30,…)` / black | `rgb(60,45,30)` | `#000000` |
| `bubble-highlight` (new) | Bubble top inner highlight, white at 15% | `rgba(255,255,255,0.15)` | `rgba(255,255,255,0.15)` |
| `grain-opacity` (new) | Noise grain 2.5% / 4% | `0.025` | `0.04` |

Glass opacity is Chat's (74% and 94%), not Clawline's (30% and 25%). Dark glass is a warm charcoal, not Clawline's neutral gray. Section 6 gives both reasons.

`composer-shadow-alpha` is retired by elevation level 2 (section 3.5). `--tb-chat-shadow` stays `#000000` in dark, and `--tb-chat-text` is never `#FFFFFF` nor `--tb-chat-background` `#000000`, as the current tests require.

### 3.2 Type

Typeface: DM Sans, variable weight 300 to 700, the Clawline typeface. Stack: `"DM Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Monospace stack: `"SF Mono", ui-monospace, SFMono-Regular, Menlo, "Fira Code", monospace` (Clawline's code stack with Chat's current fallbacks).

Sizes are in `rem` so host text zoom scales them (section 7). Clawline reference sizes convert at 16px per rem.

| Role | Chat elements | Clawline reference | Chat value |
| --- | --- | --- | --- |
| Message body | Bubble markdown, activity message content | Body text 15px / 400 / 1.5, max 65ch | `.9375rem` / 400 / 1.5; paragraphs, lists and blockquotes max `65ch` |
| Composer input | Textarea | UI labels, input text 15px | `16px` / 400 / 1.4 (kept; section 7) |
| Sender name | `.tb-chat-bubble-sender`, activity sender | 12px / 600 / 0.3px tracking | `.75rem` / 600 / `0.3px` |
| Timestamp | `.tb-chat-time` | 11px, muted | `.6875rem` / 400, tabular numerals |
| Caption | Captions, activity line, runtime notices | none (Chat-only) | `.78rem` / 400 / 1.35 (kept) |
| Pill | Activity pill | none (Chat-only) | `.72rem` / 600 (kept) |
| Markdown h1 | Heading inside a bubble | Section header 28px bold | `1.25rem` / 700 / 1.25 |
| Markdown h2 | | Subsection header 20px semibold | `1.125rem` / 600 / 1.25 |
| Markdown h3 | | | `1rem` / 600 / 1.25 |
| Markdown h4 to h6 | | | `.9375rem` / 600 / 1.25 |
| Dialog title | Modal `h2`, popup heading | Subsection header 20px semibold | `1.125rem` / 600 / 1.3 |
| Code | Code block, inline code | 13px / 1.5, SF Mono | Block `.8125rem` / 1.5; inline `.875em` |
| Empty and centered notices | `.tb-chat-empty` | none | `.9375rem` / 400, muted |

Clawline's markdown headers are page headers (28px and 20px). Inside a bubble whose body is 15px those sizes overpower the text, so Chat scales the same weights down. Clawline's content-aware sizes (22px short, 17px medium) are not used (section 6).

### 3.3 Spacing

Base unit 4px. Scale: 4, 8, 12, 16, 20, 24, 40 px (Clawline: tiny, small, compact, base, comfortable, generous, large). In rem: `.25`, `.5`, `.75`, `1`, `1.25`, `1.5`, `2.5`.

| Use | Clawline | Chat |
| --- | --- | --- |
| Bubble padding | 16px 20px (tablet), 14px 16px (phone) | `1rem 1.25rem`; at 540px and below `.875rem 1rem` |
| Gap between transcript items | 16px tablet, 12px phone | `1rem`; at 540px and below `.75rem` |
| Transcript side padding | 24px tablet, 16px phone | `1.5rem`; at 540px and below `1rem` |
| Sender to content | 10px | `.5rem` (sender sits on its own line; 8px is the nearest scale step) |
| Icon gaps | 4px | `.25rem` |
| Popover and dialog padding | 24px | `1.5rem`; at 540px and below `1rem` |

Control dimensions are touch-target sizes, not spacing, and keep their current values: composer control `2.35rem`, caption buttons `2.75rem` minimum height, modal close `2.65rem`, settings rows `2.9rem`, pill height `20px`.

### 3.4 Radii

Clawline approximates squircles "with larger border-radius values (28-32px)". The ask fixes 28px. Radii are in `px` so text zoom does not change the shape.

| Element | Radius |
| --- | --- |
| Human bubble | `28px 28px 4px 28px` (bottom-right sharp) |
| Agent bubble | `28px 28px 28px 4px` (bottom-left sharp) |
| Composer shell, modal, camera dialog, latest-prompt card | `24px` (Clawline glass field) |
| Popovers (status popup, attachment options), image frame, tool card, draft attachment chip | `16px` (Clawline photo and link card) |
| Code block, settings row, release entry | `12px` (Clawline code block) |
| Draft attachment preview, image retry button | `8px` |
| Inline code | `6px` |
| Scroll-to-latest pill, activity pill, send-action pills, send disc, status dot, modal close | `999px` / circle |

The sharp corner is always 4px. Clawline's "do not make the teardrop corner rounded" applies.

Clawline's own tables disagree about which corner is sharp: its element table gives self `24px 24px 4px 24px` (bottom-right sharp), its squircle table gives self `28px 28px 28px 4px` (bottom-left sharp). Its prose is unambiguous ("Self: Bottom-right sharp corner"). Chat follows the prose.

### 3.5 Elevation

Light comes from above. Shadows are warm (`shadow` token) in light and black in dark.

| Level | Used by | Light | Dark |
| --- | --- | --- | --- |
| 0, flat | Activity rows, captions, transition marker, chromeless bubbles | none | none |
| 1, resting | Bubbles, latest-prompt card, tool card | Clawline `--shadow-bubble`: `0 4px 20px` at 8%, `0 1px 3px` at 5% | `0 4px 20px` at 30%, `0 1px 3px` at 20% |
| 1h, raised on hover | Interactive level-1 and level-2 controls on hover (section 3.6) | Clawline `--shadow-bubble-hover`: `0 8px 30px` at 12%, `0 2px 6px` at 8% | `0 8px 30px` at 40%, `0 2px 6px` at 30% |
| 2, floating | Composer shell, scroll-to-latest pill, attachment options, status popup | Clawline top-lit layers: `0 2px 4px` at 4%, `0 8px 24px` at 8%, `0 16px 40px` at 6% | same geometry at 20%, 30%, 20% (Clawline's dark bubble alphas) |
| 3, modal | Modal, camera dialog, image viewer frame | Clawline `--shadow-device`: `0 25px 80px` at 20%, `0 10px 30px` at 10% | `0 25px 80px` at 50%, `0 10px 30px` at 30% |

Percentages are alpha of the `shadow` token, written as `color-mix(in srgb, var(--tb-chat-shadow) N%, transparent)` so no literal enters `style.css`. Bubbles also carry the Clawline top inner highlight: `inset 0 1px 0 var(--tb-chat-bubble-highlight)`.

### 3.6 Motion

| Motion | Value | Source |
| --- | --- | --- |
| Appearance change | `background-color`, `color`, `border-color` over `0.3s ease` on the surface, bubbles, glass and dialogs | Clawline "All color transitions use 0.3s ease" |
| Hover raise | `translateY(-2px)` plus level 1h, `0.2s ease`, only under `(hover: hover)` and only on interactive raised controls: scroll-to-latest pill, latest-prompt jump, settings rows, send-action pills | Clawline bubble hover; section 6 says why bubbles do not lift |
| Send spinner | `0.8s` rotation (kept) | Chat |
| Summary shimmer | `1.8s` (kept) | Chat |
| Reduced motion | Under `prefers-reduced-motion: reduce`, no transform, no shimmer, no color transition | Clawline "Consider prefers-reduced-motion to disable transforms"; Chat already does this for the shimmer |

### 3.7 Surface grain

The surface carries Clawline's noise grain at `grain-opacity`. It is an inline SVG `feTurbulence` image in a `data:` URI, painted in the viewport's background layer, so bubbles, glass and dialogs above it stay smooth ("Bubbles remain smooth: they're objects sitting on the textured surface"). It takes no pointer events and does not scroll with content.

## 4. Widget inventory

Every widget below exists at Chat `19d721be`. Class names are the code's. "Light/dark" notes only what differs between themes; every color comes from a token in section 3.1, so the theme switch is the token switch.

### 4.1 Transcript viewport

- **Anatomy**: `.tb-chat` root, `.tb-chat-viewport` scroller (labelled "*Agent* conversation"), the message list (`aria-live="polite"`), bottom padding that reserves room for the composer, safe-area insets.
- **States**: default; empty (section 4.10); loading earlier history (section 4.10); host composer hidden (bottom reserve drops to the safe area).
- **Tokens**: surface gradient `background` to `background-end`, grain, `text`, spacing 3.3.
- **Light/dark**: cream gradient with 2.5% grain; deep charcoal gradient with 4% grain.
- **Clawline adaptation**: Clawline's surface gradient and grain replace Chat's flat linen. The vertical stack and end/start alignment stay (section 6).

### 4.2 Message bubble

- **Anatomy**: `.tb-chat-bubble` with `-human` or `-agent`; optional `.tb-chat-bubble-sender`; `.tb-chat-bubble-body` with markdown and attachments; `.tb-chat-time` at the end.
- **States**: default; local (sending, section 4.3); chromeless (below). Bubbles have no hover, pressed or disabled state because they have no action.
- **Tokens**: human `human-surface` to `human-surface-end` at 135deg; agent `agent-surface-start` to `agent-surface` at 180deg in light, flat `agent-surface` in dark; `text`; radii 3.4; elevation 1 with the inner highlight; padding 3.3.
- **Size**: `fit-content`, minimum `7.5rem` (Clawline 120px), maximum `min(86%, 56rem)` (92% at 540px and below). Text blocks wrap at 65ch inside a wider bubble; tables, images and code may use the bubble's full width (Clawline OTW rule).
- **Light/dark**: sage gradient and cream gradient; deep-sage gradient and warm charcoal.
- **Chromeless**: when a bubble's body is exactly one code block, one image, or one table of five body rows or fewer, the bubble paints no background, border or shadow and keeps its padding (Clawline "Chromeless Bubbles"). This is a pure CSS selection on existing markup (`:has()`; section 7). Emoji-only and blockquote-only chromeless cases are not adopted (section 6).
- **Clawline adaptation**: Clawline's bubble colors, gradients, 28px squircle with 4px speaker corner, shadow and highlight. Human is "home" (sage), agent is "arriving" (cream).

### 4.3 Bubble meta and local send states

- **Sender** (`.tb-chat-bubble-sender`): `.75rem` / 600 / `0.3px`, `muted`, full opacity.
- **Time** (`.tb-chat-time`): `.6875rem`, `muted`, end-aligned on the bubble's last line (position kept; section 6).
- **Local bubble** (`.tb-chat-local`): the human bubble while a send is pending. 1px `border`. Ghosted state at opacity `.68` and uncertain state at `.88` (kept; these dim the bubble, not disabled text).
- **Send indicator** (`.tb-chat-send-indicator`, `.tb-chat-send-spinner`): a ring in `muted` turning at 0.8s.
- **Send uncertainty** (`.tb-chat-send-uncertainty`, `.tb-chat-send-uncertain-mark`): `caution` mark with caption text in `muted`.
- **Send error and refusal** (`.tb-chat-send-error`, `.tb-chat-send-refusal`): `danger` text at `.82rem`.
- **Send actions** (`.tb-chat-send-actions`): pill buttons, radius 999, 1px `border`, transparent fill, `text`; the primary action fills with `accent` and uses `on-accent`. Hover raise (3.6); focus ring (4.20); pressed removes the raise.
- **Light/dark**: token switch only.
- **Clawline adaptation**: Clawline sender type; timestamp size and color; terracotta as the action color.

### 4.4 Markdown content

- **Paragraphs and lists**: body type, 65ch measure, margins on the 4px scale.
- **Headings**: section 3.2 sizes, DM Sans.
- **Blockquote**: 3px `teak` inline-start rule, `muted` text (kept).
- **Links**: `fjord`, underlined; visited same; hover thickens the underline; focus ring.
- **Inline code**: `code` background, `teak` text, radius 6px, mono `.875em`.
- **Code block** (`.tb-chat-code-scroll`): `code-block` background, `code-block-text` text, radius 12px, padding 16px, `.8125rem` / 1.5, horizontal scroll, highlight.js classes on `syntax-*`. Chromeless bubble when alone (4.2).
- **Table** (`.tb-chat-table-scroll`): 1px `border` rules, header row on `code`, horizontal scroll.
- **Horizontal rule**: `border`.
- **Light/dark**: the code block is dark in both themes (Clawline `#1e1e1e`). Inline code is light in light mode.
- **Clawline adaptation**: Clawline code block, line measure and type.

### 4.5 Received attachments and image viewer

- **Anatomy**: `.tb-chat-image-attachments` list; `.tb-chat-image-frame` (4:3 while loading); `.tb-chat-image-preview-trigger` ("Enlarge *alt*"); `.tb-chat-image-loading`, `.tb-chat-image-unavailable`, `.tb-chat-image-retry` ("Retry image preview"); `.tb-chat-markdown-image`; viewer `.tb-chat-image-overlay` with `.tb-chat-image-full`, `.tb-chat-image-close` ("Close image preview", drawn as `×`); the viewer heading is the image's alt text.
- **States**: loading (frame on `code`, "Loading" label), loaded, unavailable (`muted` text), retry (button), focus, viewer open. Retry hover and pressed follow 4.17; retry is never disabled.
- **Tokens**: frame radius 16px, image width up to `22rem` and max height `22rem` (kept; Clawline photo max 360px is 22.5rem); retry radius 8px; viewer frame elevation 3.
- **Alt text**: Chat draws no visible alt-text element. An image's alt text reaches the reader as the image's `alt`, the trigger's name "Enlarge *alt*", the unavailable frame's name "*alt*; preview unavailable", the loading frame's name "Loading *alt*" and the viewer heading, which is visually hidden. A Markdown image without alt text uses "Image". The `.tb-chat-image-alt` rule in `style.css` styles no element: Markdown images render as thumbnails through `.tb-chat-markdown-image`, so that rule gets no treatment here.
- **Other received attachments** (`.tb-chat-attachments`, with `.tb-chat-attachment-content` wrapping the detail in the transcript's animated disclosure): a disclosure below the message body for attachments that are not images. Its summary reads "*n* attachment detail" or "*n* attachment details"; opening it shows the attachments as formatted text. Summary in body type at `.9rem`, `muted`; detail text in the monospace stack (3.2) at the code size `.8125rem` / 1.5, `muted`, wrapping with no horizontal page scroll (kept); no fill, no border, elevation 0. States: closed, open, summary focus ring (4.16). The summary has no hover or pressed treatment beyond the pointer cursor and is never disabled.
- **Light/dark**: the viewer backdrop and close control keep their current literal white-on-dark treatment in `messageAttachments.css` in both themes, because a photo viewer is neutral by design. The attachment disclosure is a token switch.
- **Clawline adaptation**: Clawline photo rules: rounded 16px corners, never full-flow width, chromeless when an image is alone. Clawline has no non-image attachment vocabulary, so the disclosure takes Chat's muted metadata voice and Clawline's code type.

### 4.6 Captions and runtime notices

- **Caption** (`.tb-chat-caption`, `-neutral`, `-caution`, `-danger`): `.78rem`, a `•` lead, `muted` for neutral; caution and danger mixed at 94% with `background`.
- **Caption buttons**: underlined text buttons, `2.75rem` minimum height, focus ring in `currentColor`. Hover thickens the underline, as links do (4.4); pressed shows the same thickened underline, with or without a hover-capable pointer. Color and fill stay the caption's, so the caption's contrast holds. Disabled: today only the "Retry tool history" button in the hidden placeholder that reserves the tool history status's space is disabled, and it is never visible. The existing disabled look stays for it: `muted` text, underline kept, no hover or pressed change, default cursor, no opacity.
- **Render failure** (`.tb-chat-render-failure`): `danger` caption with buttons to show the raw transcript.
- **Runtime notice** (`.tb-chat-runtime-notice`): a caption pinned near the top of the viewport, up to `46rem` wide. Neutral while loading ("Loading earlier messages…", `.tb-chat-history-loading`); danger with a button for history errors ("Retry loading messages"), session errors ("Reconnect") and a link ("Open the configured conversation"). It may carry the tool history status beside it.
- **Tool history status** (`.tb-chat-tool-history-status`): "Loading tool history…" (neutral caption), or "Tool history is not current" with "Retry tool history" (danger caption).
- **Active caption** (`.tb-chat-active-caption`): centered, `muted`, with an `ok` icon. Labelled "Active turn: …".
- **States**: neutral, caution, danger, loading, retry focus, button hover, button pressed, button disabled.
- **Clawline adaptation**: Clawline's muted metadata voice. Captions and runtime notices are Chat-only and stay flat (elevation 0), in body type.

### 4.7 Transition marker

- **Anatomy**: `.tb-chat-transition-marker` full-bleed band with `.tb-chat-transition` label. Labelled "Transition: …".
- **Tokens**: `transition` text on `transition` mixed at 8% into the surface; 42% border.
- **States**: default only.
- **Clawline adaptation**: none needed beyond tokens. It plays the role Clawline gives date separators (section 6).

### 4.8 Activity rows

- **Activity line** (`.tb-chat-activity-line`): one line, ellipsized, `.78rem`. Color by kind: agent `fjord`; substrate and tool `muted`; rail `caution`.
- **Activity pill row** (`.tb-chat-activity-pill-row`, `-disclosure`): a pill, the sender, gist text in `muted`, meta in mono `.7rem`. Disclosure expands a detail rail.
- **Activity pill** (`.tb-chat-activity-pill`): 20px tall, radius 999, ink mixed at 14% into `background`, `.72rem` / 600. Tones: green `ok`, amber `caution`, orange `teak`, red `danger`, blue `fjord`, purple `pill-purple`, indigo `pill-indigo`, slate `muted`.
- **Activity run** (`.tb-chat-activity-run`, `-toggle`, `-chevron`, `-count`): a collapsed group with chevron and count; expanded rows sit under a 24% top rule. Tool runs show the terminal icon in `caution`.
- **Overflow** (`.tb-chat-activity-overflow`): "Show earlier activity", `muted`.
- **Summary** (`.tb-chat-summary-pending`, `.tb-chat-summary-marker`): "summarizing" with a 1.8s shimmer, "summarized" plain, `.7rem` `muted`.
- **Tool card** (`.tb-chat-tool`): bordered card, radius 16px, padding 12px, elevation 0 inside a bubble.
- **States**: collapsed, expanded, focus (2px `currentColor` ring), hover (underline on gist for toggles), loading (shimmer).
- **Light/dark**: token switch. All pill inks pass on their fill over both surface stops in both themes (section 9).
- **Clawline adaptation**: Clawline has no activity vocabulary. These rows take Clawline type, color family and radius and stay flat so the bubbles remain the landmarks. Indigo gets its own token because `accent` becomes terracotta and would collide with orange.

### 4.9 Latest-prompt card and scroll-to-latest pill

- **Latest-prompt card** (`.tb-chat-latest-user-prompt`): centered at the top; `human-surface` gradient, radius 24px, elevation 1; text up to three lines with ellipsis; jump button ("Jump to user prompt") and dismiss `×` ("Dismiss user prompt preview").
- **Scroll-to-latest pill** (`.tb-chat-scroll-latest`): bottom center above the composer, radius 999, `composer-glass` with `glass-edge`, blur, elevation 2, `text` label. Today it is opaque `background`; it becomes glass so it reads as the composer's companion.
- **States**: hidden, shown, hover raise, pressed, focus ring.
- **Clawline adaptation**: the card is a small "home" bubble lifted off the surface; the pill is a glass object like the composer.

### 4.10 Empty and loading transcript

- **Connecting** (`.tb-chat-initial-caption`): before the runtime opens, the transcript region (`role=status`, "Conversation") shows only a loading status dot (`caution`) with the screen-reader text "Connecting".
- **Empty**: "No messages yet." centered, `muted`, `.9375rem`.
- **Loading earlier**: runtime notice (4.6).
- **Clawline adaptation**: Clawline's muted metadata voice; no illustration.

### 4.11 Composer

- **Anatomy**: `.tb-chat-composer` floating at the bottom; `.tb-chat-input-shell` holding the status control (`.tb-chat-status-dot`, "Connection status: … Show details"), the attachment control `+` ("Add attachment"), the textarea ("Message to *agent*", placeholder the agent name), the empty title (`.tb-chat-empty-title`, the agent name in `placeholder` color, 16px, ellipsized, shown while the field is empty), and the send button (`.tb-chat-send-button` with `.tb-chat-send-button-disc`, "Send message").
- **States**: empty (`-empty`), with text, focused, disabled send (disc at opacity `.48`, kept as the only allowed disabled opacity), sending, no status (`-no-status`), keyboard open (safe-area bottom drops to 0), camera open, host composer hidden (not drawn).
- **Status dot**: idle `idle`, ready `ok`, loading `caution`, error `danger`.
- **Tokens**: shell `composer-glass`, `glass-edge` 1px, `blur(16px) saturate(180%)`, radius 24px, elevation 2; send disc `accent` with `on-accent` arrow; controls focus ring `accent` 2px.
- **Light/dark**: white glass over cream; charcoal glass over charcoal.
- **Clawline adaptation**: Clawline's liquid glass input: no panel behind it, floating directly over the transcript, neutral glass, blur 16, saturation 180%, light edge, 24px field radius, terracotta send. Opacity and the integrated shell are departures (section 6).

### 4.12 Attachment options, draft attachments and attachment send

- **Attachment options** (`.tb-chat-attachment-options`, "Add to message"): popover with "Choose photos", "Choose files", camera. `glass`, blur 16, saturate 180%, radius 16px, elevation 2. Option hover: `accent` mixed at 12%.
- **Draft attachments** (`.tb-chat-draft-attachments`, "Attachments in this draft"): chips on `agent-surface` with 1px `border`, radius 16px; preview radius 8px; name, kind and type in `muted`; remove button ("Remove *name*"); error in `danger`; retry ("Retry attachment preparation").
- **Attachment send** (`.tb-chat-attachment-send`, "Attachment send status"): heading, per-file items with status, reason and retry ("Retry attachment send").
- **Remove and retry controls**: the remove button (`.tb-chat-draft-attachment-remove`) and both retry buttons (`.tb-chat-attachment-send-retry`, "Retry attachment preparation" and "Retry attachment send") take hover and pressed from 4.17. "Retry attachment send" is disabled while Chat is unauthorized and then shows the 4.17 disabled treatment. The remove button and "Retry attachment preparation" are never disabled.
- **Composer error** (`.tb-chat-composer-error`): `danger` text above the shell.
- **States**: closed, open, option hover, focus, chip error, retry, remove and retry hover and pressed, send retry disabled.
- **Clawline adaptation**: glass popover; chips are small "arriving" cards.

### 4.13 Camera dialog

- **Anatomy**: `.tb-chat-camera-backdrop`, `.tb-chat-camera-dialog` (`role=dialog`), `.tb-chat-camera-preview` ("Camera preview") on `code-block`, `.tb-chat-camera-actions`, `.tb-chat-camera-error`.
- **States**: opening, live, error (`danger`), closing.
- **Tokens**: dialog `background` surface, radius 24px, elevation 3; backdrop `shadow` at 34%.
- **Clawline adaptation**: modal card with Clawline device shadow.

### 4.14 Modal: What's new, Settings, Release notes

- **Anatomy**: `.tb-chat-overlay` backdrop; `.tb-chat-modal` (`role=dialog`, `aria-modal`), up to `42rem` wide; `.tb-chat-modal-header` with `h2` title and `.tb-chat-modal-close` ("Close *title*"); `.tb-chat-modal-content`.
- **Pages**: "What's new" (release entries); "Settings" home with one `.tb-chat-settings-item` "Release notes ›"; "Release notes" with `.tb-chat-settings-back`.
- **Release entry** (`.tb-chat-release-entry`): version heading and notes, separated by 1px `border`, radius 12px block.
- **States**: open, close hover, close pressed, focus ring, settings row hover raise and pressed. The close button is never disabled.
- **Tokens**: modal surface gradient `background` to `background-end`, smooth with no grain (R8), radius 24px, elevation 3; close 2.65rem circle on `agent-surface`, and on hover and pressed `accent` mixed at 12% into `agent-surface` (4.17), border and `text` glyph unchanged; rows 2.9rem on `agent-surface`, radius 12px; backdrop `shadow` at 34%.
- **Clawline adaptation**: a modal is a large card lifted off Clawline's surface: the same warm gradient without the grain (cards and bubbles stay smooth), top-lit device shadow, squircle radius.

### 4.15 Status popup

- **Anatomy**: `.tb-chat-status-popup` (`role=dialog`, "Connection details"), `.tb-chat-popup-heading` with close ("Close connection details"), a definition list.
- **Tokens**: opaque `background` with no glass and no blur, radius 16px, elevation 2, `muted` terms, `text` values. It stays opaque because its `muted` terms would fail on glass (dark `muted` on `glass` over a light backdrop is 2.81:1).
- **States**: open, close focus.
- **Clawline adaptation**: Clawline card with top-lit shadow; not glass.

### 4.16 Focus ring

All focusable controls show a 2px solid ring at offset 3px. Ring color is `accent`, except in captions and activity rows, which keep `currentColor`. Today the general ring uses `border`, which is nearly invisible on the surface. The adaptation makes the ring Clawline terracotta, which passes 3:1 against the surface in both themes.

### 4.17 Small control states

These are the hover, pressed and disabled looks for the small flat controls that do not raise (3.6): image retry (4.5), draft attachment remove and the attachment retry buttons (4.12), and modal close (4.14). Caption buttons have their own text-button treatment (4.6).

- **Hover**: the control's fill becomes `accent` mixed at 12% over the surface it sits on, the value Chat already uses for attachment option hover (4.12). Applies only under `(hover: hover)`. Glyph, text color, border and size do not change, and nothing moves.
- **Pressed**: the same 12% `accent` fill while the control is pressed, with or without a hover-capable pointer, so a touch press gets feedback.
- **Disabled**: only where existing UI disables the control. `muted` text, the control's resting fill and border, no hover or pressed fill, default cursor, no opacity. Opacity stays reserved for the disabled send disc (4.11).
- **Motion**: fill changes are immediate, with no transition, so R12 holds without a reduced-motion variant.
- **Clawline adaptation**: Clawline defines hover only as a lift for bubbles and its theme toggle and has no pressed or disabled states. A lift on these small controls would compete with the raised controls in 3.6, so they take Chat's terracotta tint instead.

## 5. Navigation

Chat has one screen, the transcript, plus overlays. Each element below is specified in the widget it belongs to.

| Move | Trigger | Element | Returns by |
| --- | --- | --- | --- |
| Read history | Scroll up; earlier messages load at the top | Viewport (4.1), history notice (4.6) | Scroll down |
| Return to latest | Scroll-to-latest pill appears when away from the end | Pill (4.9) | n/a |
| Return to own last prompt | Latest-prompt card shows while the prompt is off screen | Card jump (4.9) | Scroll; dismiss `×` hides the card for that session |
| Open connection details | Status dot in the composer | Status popup (4.15) | Close, Escape |
| Add an attachment | `+` in the composer | Attachment options (4.12), camera (4.13) | Choose, Escape, outside tap |
| Open settings | Type exactly `/settings` and send; or a host that uses Chat's settings request opens it. Tuner's own Settings menu item and shortcut open Tuner's settings, not this modal, and this step adds no wiring between them | Settings modal (4.14) | Close, Escape |
| Read release notes | Settings home row "Release notes ›" | Release notes page (4.14) | Back row to home; close |
| See what changed | Opens itself once per new version, then records it as seen | What's new (4.14) | Close, Escape |
| View an image | Tap an image | Image viewer (4.5) | Close, Escape |
| Expand activity | Run toggle, pill disclosure, "Show earlier activity" | Activity rows (4.8) | Toggle again |

Navigation keeps its current behavior. The restyle changes only how these elements look.

## 6. Departures from Clawline

Each departure keeps a Chat behavior or invariant the ask did not authorize changing.

1. **No avatars.** Clawline calls avatar waypoints a core principle. Chat has no avatar component, and this step may not add one. Agent identity stays in the sender line and the accessible labels. Open question Q4.
2. **No flow layout; human end, agent start.** Clawline wraps short messages side by side and rejects left/right alignment. Chat's transcript interleaves full-width activity rows, transition bands and captions with long agent answers, so side-by-side bubbles would break those rows apart. Wrapping would also move content while history loads above the reader. Chat keeps end/start alignment; the sharp corner still points at the speaker as Clawline requires.
3. **No content-aware type sizes or 2x emoji.** Clawline sizes short messages larger. That needs classification of each message, which is new behavior. Chat uses one body size.
4. **No random corner variations.** Clawline varies corner radii between bubbles. Bubbles would change shape as history re-renders. Chat uses the base radii only.
5. **No truncation with fade.** Clawline clips long messages. Chat never hides a reader's content.
6. **No link previews.** A preview card is a feature.
7. **No date separators.** A new component. Chat's transition markers already break the transcript into episodes.
8. **Timestamp stays at the end of the bubble, at full opacity, in Chat's format.** Clawline puts it in a header line at 70% opacity with relative formats. Moving it would add a header line to every human bubble, 70% opacity fails 4.5:1, and the format is content, not style. Sender names also stay at full opacity for the same contrast reason.
9. **No manual theme toggle.** Chat follows the system appearance; a toggle is a feature.
10. **No caustics, dust or avatar spheres.** Clawline specifies these for its native app.
11. **Glass is denser.** Clawline glass is 30% (light) and 25% (dark). At those opacities composer text over a busy transcript falls below 4.5:1. Chat keeps 74% (popovers) and 94% (composer) and takes Clawline's blur, saturation, edge and radius.
12. **Dark glass is warm charcoal, not neutral gray.** At 74%, Clawline's `rgb(60,60,60)` left the placeholder at 3.5:1 over light backdrops. `rgb(44,40,37)` from Clawline's dark surface family passes.
13. **Integrated composer shell.** Clawline separates the field and a 48px glass send circle. Chat's shell holds the status dot, `+`, field and send disc, sized for touch at 2.35rem. The send disc is a terracotta fill, because a glass circle inside a glass shell would be invisible.
14. **Blue, purple and indigo inks kept.** Clawline has no blue or purple. Chat's activity pills encode record kinds by hue, and links need a hue distinct from text and terracotta. These inks are tuned to the Clawline palette's lightness but keep their hues.
15. **Bubbles do not lift on hover.** Clawline lifts bubbles "to indicate interactivity". Chat bubbles have no action, so a lift would promise one. Chat applies the lift to interactive raised controls instead (3.6).
16. **Lightness adjustments.** Light `muted`, `ok`, `caution`, `accent` and `teak` are deeper than Clawline's stone, sage, gold and terracotta, and dark `muted` is lighter than stone, to meet 4.5:1 on the sage human bubble and the surface (section 9). Hue families are unchanged.
17. **Emoji-only and blockquote-only chromeless bubbles not adopted.** Emoji needs 2x sizing (departure 3). Clawline marks blockquote "future".
18. **Image viewer literals stay.** The full-screen viewer keeps its neutral black and white treatment in both themes.

## 7. Platform constraints

### 7.1 Tuner on iOS (WKWebView)

- The web view is not opaque. Its background and under-page color are Tuner's own `nordicBackground` color, which matches Chat's current linen. While the page loads, during overscroll and around the page, the user sees that native color. Once Chat's surface changes, Tuner's color will not match until Tuner is updated (Q1).
- Tuner adds the native composer's height to the page's bottom safe area. Chat's bottom reserve, scroll-to-latest pill and composer position already read `env(safe-area-inset-bottom)`; the restyle must keep that.
- In host composer mode Chat's composer is not drawn. The native composer uses SwiftUI glass with its own tint and an 11.5pt status dot. Section 4.11 does not apply to it (Q1).
- Tuner's text zoom sets `-webkit-text-size-adjust` from 70% to 200%. WebKit applies that setting to text size; whether `rem` spacing and `rem` control sizes follow it in Tuner is not established and is to be measured in the restyle's Tuner screenshots. Radii in `px` do not scale. The composer textarea must stay at 16px or larger so iOS does not zoom the page on focus.
- Tuner can force light or dark through `preferredColorScheme`. Whether WKWebView reports that to the page's `prefers-color-scheme` is not established (Q2).
- `backdrop-filter` and `:has()` are supported in the WebKit versions Tuner targets (assumption A2).

### 7.2 Tuner on desktop (Qt WebEngine)

- The page renders in a `WebEngineView` whose `zoomFactor` follows Tuner's text scale. Page zoom scales every length, including `px` radii and the grain tile.
- A 34px glass sidebar toggle sits at the top-left corner, 12px from each edge, over the page. Chat's latest-prompt card is centered and does not reach that corner at normal widths (Q3).
- Chat draws its own composer here.
- Tuner's desktop palette is QML (`TunerPalette.qml`) and mirrors Chat's current tokens; it will not match the new surface until updated (Q1).
- `color-scheme` follows the system through Qt's style hints.

### 7.3 Standalone page and host composer example

`examples/site.css` paints the page body with the surface tokens, and `.chat-entry-state` text with `muted` and `fjord` links. `examples/hostComposer.css` draws the example host panel from tokens. Both stay literal-free.

### 7.4 Breakpoints

540px and below: phone values in 3.3 and 4.2. 541px to 767px: current intermediate rules kept. These are Chat's existing breakpoints; Clawline's iPad and iPhone values map to them.

### 7.5 Font asset

DM Sans ships with Chat as one variable-weight `woff2` file, Latin subset, under the SIL Open Font License 1.1. Justification: the ask names DM Sans; without the file every host would fall back to its system font, and fetching from a font service would add a third-party network dependency to every Chat page and to Tuner. The file is listed in `THIRD_PARTY_NOTICES.md`. `font-display: swap` keeps text readable while it loads. No npm package is added. This is the only asset this design adds.

## 8. Requirements

Each requirement cites what it serves. Keywords follow RFC 2119 as clarified by RFC 8174.

**R1. Palette.** Chat SHALL define the light and dark token values in section 3.1 in `src/theme.css` and use no color literal in `src/style.css`, `examples/site.css` or `examples/hostComposer.css`. Serves: the ask (a) "color (light and dark)" and the existing literal ban.
*Example*: in light, `getComputedStyle(root).getPropertyValue('--tb-chat-human-surface')` is `#B8CEAF`; grepping `style.css` for `#` color literals finds none.

**R2. Legibility.** Every pair in section 9 SHALL measure at least 4.5:1 in both themes, including `text` and `placeholder` on both `glass` and `composer-glass` over each of the 29 color tokens in 3.1 used as a backdrop, `code-block` among them. Serves: Clawline "Meets WCAG AA (4.5:1 minimum)" and Chat's theme tests.
*Example*: `muted` on `human-surface` in light is 4.66, which passes; changing `muted` to Clawline stone `#A69B8D` makes it fail.

**R3. Type.** Chat text SHALL render in DM Sans with the section 3.2 sizes, and SHALL fall back to `system-ui` while the font loads or if it is unavailable. Serves: the ask "DM Sans", (a) "type scale".
*Example*: with the font file blocked, the transcript renders in the system font with no layout break; with it loaded, a bubble's computed `font-family` begins with `"DM Sans"`.

**R4. Measure.** Paragraph, list and blockquote text inside a bubble SHALL wrap at no more than 65ch, while code, tables and images MAY extend to the bubble's width. Serves: Clawline OTW rule.
*Example*: a 600-character paragraph next to a wide table: the table spans the bubble, the paragraph wraps at about 65 characters.

**R5. Spacing.** New spacing values SHALL come from the 4px scale in 3.3, except the phone bubble padding, which keeps Clawline's 14px by 16px (`.875rem 1rem`) as the one off-scale value. Serves: the ask "4px spacing base"; Clawline phone bubble padding.
*Example*: bubble padding computes to 16px by 20px at 1024px wide and 14px by 16px at 390px.

**R6. Shape.** Human bubbles SHALL have a 4px bottom-right corner and agent bubbles a 4px bottom-left corner, with 28px on the other three. Serves: the ask "28px squircle radii"; Clawline teardrop.
*Example*: computed `border-radius` of a human bubble is `28px 28px 4px 28px`.

**R7. Elevation and light.** Bubbles SHALL use level 1 with the top inner highlight, floating controls level 2, and dialogs level 3, using the `shadow` token. Serves: the ask "warm top-lit shadows".
*Example*: in light, the composer shell's computed `box-shadow` has three layers whose colors are `rgb(60,45,30)` at 4%, 8% and 6%.

**R8. Grain.** WHILE the transcript is displayed, the surface SHALL show noise grain at `grain-opacity`, and bubbles, glass and dialogs SHALL NOT show it. Serves: the ask "subtle noise grain".
*Example*: a screenshot crop of empty surface shows pixel variance; a crop inside a bubble shows none.

**R9. Accents.** The send disc, primary send action and focus ring SHALL use `accent` (terracotta); human bubbles SHALL use the sage surface. Serves: the ask "terracotta and sage accents".
*Example*: in dark, the send disc fill computes to `#E07A5F` and the human bubble starts at `#2D3B2A`.

**R10. Glass.** The composer shell and scroll-to-latest pill SHALL use `composer-glass`, and the attachment options popover SHALL use `glass`, each with `blur(16px) saturate(180%)` and a `glass-edge` border, with no opaque panel behind the composer. No other widget SHALL use glass, and `muted` text SHALL NOT be placed on glass. Serves: Clawline liquid glass; R2.
*Example*: scrolling a code block under the composer shows it blurred through the shell; the status popup and modals show no transcript through them.

**R11. Chromeless.** WHEN a bubble's body holds only one code block, one image, or one table with five or fewer body rows, THE bubble SHALL paint no background, border or shadow and SHALL keep its padding. Serves: Clawline chromeless bubbles.
*Example*: a bubble with only a fenced code block shows the dark block on the surface; the same block followed by a sentence shows the bubble.

**R12. Motion.** Hover raise SHALL apply only to the controls in 3.6 and only under `(hover: hover)`; WHEN the user prefers reduced motion, Chat SHALL apply no motion transform (hover raise), shimmer or color transition. Static centering transforms, such as the scroll pill's `translateX(-50%)`, are layout and stay. Serves: Clawline hover and motion rules.
*Example*: on a touch device, tapping the scroll pill does not translate it; on desktop, hovering it raises it 2px.

**R13. Appearance follows the system.** WHEN the system appearance changes, Chat SHALL switch token sets, with color transitions of 0.3s unless reduced motion applies. Serves: the ask "light default plus a full dark palette".
*Example*: toggling the OS to dark while Chat is open recolors it without reload.

**R14. Visual only.** The restyle SHALL NOT change navigation (section 5), DOM structure, accessible names, behavior or package dependencies, and SHALL add no asset except the font in 7.5. Serves: delivery "No new components, features, behavior changes or dependencies".
*Example*: the restyle diff touches CSS, `theme.css`, the font file, its notice and tests that pin style values, and nothing under component logic.

**R15. Host fit.** Chat SHALL keep reading the safe-area insets and SHALL keep the composer textarea at 16px or larger. Serves: platform constraints (e).
*Example*: in Tuner on iOS with the native composer, the last message clears the native composer; focusing Chat's own textarea on iPhone does not zoom the page.

**R16. Small control states.** WHILE a pointer that can hover is over image retry, draft attachment remove, an attachment retry button or modal close, or WHILE any of them is pressed, THE control SHALL show `accent` mixed at 12% over its surface with its glyph, text color, border and size unchanged; WHILE a caption button is hovered or pressed, its underline SHALL thicken with its color unchanged; WHILE one of these controls is disabled, it SHALL show `muted` text with no hover or pressed change and no opacity. Serves: the Chat product owner's revision request to "document hover, pressed and disabled visual states for caption buttons, image retry, attachment remove and retry, and modal close, including an existing semantic token for the close hover".
*Example*: on desktop in light, hovering "Close Settings" fills the circle with `accent` at 12% over `agent-surface` and the `×` stays `text`; on a phone, pressing it shows the same fill; "Retry attachment send" while Chat is unauthorized shows `muted` text and no fill on press.

## 9. Evidence: contrast of the proposed palette

Computed with the same math as `tests/theme.test.ts` (WCAG relative luminance, alpha compositing, sRGB mixing) for both surface gradient stops, the human gradient's two stops, and both glass tokens over each of the 29 color tokens in 3.1 as a backdrop (including `code-block` and the syntax colors). The computation script is kept with the work item's records, not in this repository. Lowest values per theme are in bold.

| Pair | Light | Dark |
| --- | --- | --- |
| text on background / background-end | 10.19 / 9.32 | 13.83 / 14.78 |
| text on agent-surface | 11.38 | 11.99 |
| text on human-surface / human-surface-end | 7.25 / 8.21 | 9.38 / 10.57 |
| text on code | 9.32 | 14.78 |
| muted on background / background-end | 6.55 / 5.98 | 7.06 / 7.55 |
| muted on agent-surface | 7.31 | 6.13 |
| muted on human-surface / human-surface-end | **4.66** / 5.28 | **4.79** / 5.40 |
| fjord on background / background-end | 7.11 / 6.50 | 8.19 / 8.76 |
| fjord on agent-surface | 7.93 | 7.11 |
| fjord on human-surface / human-surface-end | 5.06 / 5.73 | 5.56 / 6.26 |
| fjord on code | 6.50 | 8.76 |
| teak on code | 6.02 | 7.87 |
| caution on human-surface / human-surface-end | 4.99 / 5.65 | 6.10 / 6.87 |
| caution on background / background-end | 7.02 / 6.42 | 8.99 / 9.60 |
| danger on human-surface / human-surface-end | 4.84 / 5.48 | 4.93 / 5.55 |
| danger on background / background-end | 6.80 / 6.22 | 7.27 / 7.77 |
| code-block-text on code-block | 13.18 | 13.18 |
| syntax keyword, string, number, comment, title on code-block | 8.09, 9.88, 9.23, 7.53, 9.81 | same |
| on-accent on accent | 4.83 | 5.93 |
| text on `glass`, worst of 29 backdrops | 7.03 (over `code-block`) | 5.49 (over `text`) |
| placeholder on `glass`, worst of 29 backdrops | **4.67** (over `code-block`) | **4.64** (over `text`) |
| text on `composer-glass`, worst of 29 backdrops | 10.85 | 9.85 |
| placeholder on `composer-glass`, worst of 29 backdrops | 7.21 | 8.32 |
| transition on its 8% band over background / background-end | 5.05 / **4.63** | 6.33 / 6.86 |
| caution caption (94% mix) over background / background-end | 6.08 / 5.60 | 8.08 / 8.59 |
| danger caption (94% mix) over background / background-end | 6.04 / 5.57 | 6.56 / 6.98 |
| pill inks on their 14% fill, worst over background-end (green, amber, orange, red, blue, purple, indigo, slate) | 4.81, 5.23, 4.93, 5.01, 5.29, **4.71**, 4.74, 4.92 | 6.38, 7.41, 6.28, 6.23, 6.86, 7.06, 7.22, 6.05 |
| status dots ok, caution, danger, idle on composer glass (non-text, 3:1) | 7.58, 8.31, 8.06, 7.75 | 6.35, 7.60, 6.15, 5.97 |
| send disc `accent` on composer glass (non-text, 3:1) | 5.29 | 5.01 |
| text on the 4.17 hover fill (`accent` at 12%), worst over agent-surface, human-surface, human-surface-end, background, background-end and composer glass | 6.38 (over human-surface) | 8.02 (over human-surface) |

Also checked: `transition` is less prominent than `text` on the surface, `transition` differs from `ok`, and `fjord`, `muted`, `teak` and `caution` are four distinct colors, as the current tests require.

Tests that pin today's exact values (palette constants, glass minimums 7.47 / 5.06 / 4.54 / 4.50, glass alpha strings, `blur(14px)`, code block on `code`, syntax on `code`) change with the restyle to the values here. The substantive invariants above stay, and two pairs are added: `code-block-text` on `code-block`, and syntax colors on `code-block`.

## 10. Assumptions

- **A1.** The library build inlines the font file into `dist/index.css` or ships it beside it so consumers of `@clickety-clacks/tightbeam-chat/style.css` get it without extra setup. Falsified if a consumer page renders in the fallback font after a clean install.
- **A2.** WebKit on Tuner's supported iOS versions and Qt WebEngine in Tuner's desktop build support `:has()`, `backdrop-filter` and `color-mix()`. Falsified by a missing chromeless effect, blur or mix on either host. Chat already uses `color-mix()` and `backdrop-filter`, so only `:has()` is new.
- **A3.** The grain image costs no visible scroll performance on the oldest supported phone. Falsified by dropped frames attributable to the grain layer.
- **A4.** Release notes and other Chat copy need no change for this restyle.

## 11. Non-goals

- Any new component, feature or behavior, including avatars, link previews, date separators, a theme toggle, flow layout, content-aware sizing and truncation.
- Changes to Clawline, to Tuner, or to the native composer.
- Release, packaging or installation changes.
- Changing navigation, accessible names or copy.
- Performing the restyle. This document stops before it.

## 12. Open questions

- **Q1. Tuner palette parity. BLOCKING for Tuner screenshot acceptance only; NON-BLOCKING for this document and the in-page restyle.** Tuner paints its own linen around and under the page, and its native composer and desktop chrome use Tuner colors that mirror Chat's current tokens. After the restyle, Tuner shows a linen edge on overscroll and a non-Clawline composer in host composer mode. Matching them is a change in Tuner, outside this repository and this step. The product owner decides whether Tuner parity is part of this ask. Whatever that decision, it does not waive the restyle's Tuner screenshots, which Q2 and Q3 also depend on.
- **Q2. Forced appearance in Tuner. NON-BLOCKING.** If WKWebView does not pass Tuner's forced light or dark setting to `prefers-color-scheme`, Chat follows the phone's setting rather than Tuner's. To verify in the restyle's Tuner screenshots.
- **Q3. Desktop sidebar toggle overlap. NON-BLOCKING.** The 34px toggle at Tuner's top-left may overlap a long latest-prompt card on very narrow desktop windows. To check in screenshots.
- **Q4. Avatars and content-aware type later. NON-BLOCKING.** Clawline treats avatars as essential landmarks. Adding them is a new component and needs a separate product decision.
