---
name: Flight Delay Prediction
description: A departure-board dashboard over 5.8M US domestic flights from 2015, from volume to analysis to prediction to honest evaluation.
colors:
  ground: "#010101"
  ink: "#f2f1ec"
  ink-2: "#b9b8b3"
  ink-3: "#94938f"
  rule: "rgba(255, 255, 255, 0.08)"
  rule-strong: "rgba(255, 255, 255, 0.16)"
  wash: "rgba(255, 255, 255, 0.05)"
  tooltip-surface: "#0b0b0b"
  delayed: "#e8a54b"
  ontime: "#7c9bd1"
  cancelled: "#d0614a"
  cause-late: "#e8a54b"
  cause-carrier: "#7c9bd1"
  cause-nas: "#9a8fc4"
  cause-weather: "#5fa38a"
  cause-security: "#c9c4b8"
typography:
  display:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "clamp(3rem, 9vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.98
  headline:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "clamp(2.25rem, 5vw, 3.25rem)"
    fontWeight: 400
    lineHeight: 1
  title:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.25
  figure:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "clamp(1.75rem, 3vw, 2.5rem)"
    fontWeight: 400
    lineHeight: 1.1
    fontFeature: "tnum"
  route-code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "19px"
    fontWeight: 400
    letterSpacing: "0.04em"
  link-title:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "1.6rem"
    fontWeight: 400
    lineHeight: 1
  wordmark:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1
  body:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 300
    lineHeight: 1.625
  ui:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 300
  label:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 300
  column-head:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.025em"
  data:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  hairline: "2px"
  skeleton: "3px"
  cell: "6px"
  field: "8px"
  flight-field: "12px"
  panel: "24px"
  pill: "9999px"
spacing:
  gutter-mobile: "20px"
  gutter-desktop: "40px"
  section-top: "24px"
  block-gap: "32px"
  column-gap: "40px"
  board-row: "36px"
  container: "1440px"
  side-column: "420px"
components:
  tab:
    textColor: "{colors.ink-2}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
  tab-active:
    backgroundColor: "{colors.rule-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
  button-outline:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 16px"
  button-outline-hover:
    backgroundColor: "{colors.wash}"
  button-glass:
    backgroundColor: "rgba(255, 255, 255, 0.02)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "12px 24px"
  button-glass-hover:
    backgroundColor: "rgba(255, 255, 255, 0.07)"
  segmented:
    backgroundColor: "{colors.wash}"
    rounded: "{rounded.pill}"
    padding: "4px"
  segmented-option-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  select-field:
    backgroundColor: "rgba(1, 1, 1, 0.6)"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 36px 10px 12px"
  board-row:
    typography: "{typography.data}"
    height: "{spacing.board-row}"
  board-row-hover:
    backgroundColor: "{colors.wash}"
  rate-cell:
    textColor: "{colors.delayed}"
    typography: "{typography.data}"
  predict-panel:
    backgroundColor: "rgba(255, 255, 255, 0.02)"
    rounded: "{rounded.panel}"
    padding: "32px"
  tooltip:
    backgroundColor: "{colors.tooltip-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
---

# Design System: Flight Delay Prediction

## Overview

**Creative North Star: "The Departure Board"**

Every ranking is a departure board. Airlines, airports, routes and months are rows in fixed tabular columns on a near-black ground, and the delay rate is the lit amber column. The system rejects the category default of a grey card grid of identical chart tiles: blocks are separated by hairline rules, not boxes, and a single page reads top to bottom as one continuous board.

The world is dark and quiet so the data can glow. Ink is warm off-white stepped down in three levels; colour is spent only on encoding data (the dusk palette), never on decoration. A serif (Instrument Serif) gives page titles and headline figures a printed, editorial voice; Geist carries the interface; Geist Mono with tabular figures carries board rows so digits line up like split-flap characters. Density is high but calm: 36px rows, 11-13px UI text, and generous 40px gutters between the main column and the side column.

There is one moment of material: the Predict panel is the only glass surface, because scoring a flight is the one place the visitor acts rather than reads. Motion is reserved for the signature move: when a board re-sorts or refilters, rows glide to their new rank and changed rows hold an amber lamp, then fade.

**Key Characteristics:**
- Near-black ground (#010101), warm ink stepped by three levels, hairline rules instead of cards.
- Dusk palette as data encoding: amber delayed, blue on time, red cancelled, violet NAS, green weather.
- Serif for titles and headline figures, Geist for UI, Geist Mono tabular figures for data.
- Departure-board tables with an inline delay-rate bar and a lamp on re-rank.
- One glass surface, on Predict only.
- Every data block has loading, error-with-retry and empty states.

## Colors

A near-monochrome dark world in which the only saturated colours are data.

### Primary
- **Departure Amber** (delayed): the delay rate, delayed flights, the "delayed" share of any chart, the late-aircraft cause, and the heatmap ramp (amber at 0.1 to 1.0 alpha). It also lights the board lamp. Outside data it appears only as the keyboard focus ring, the focused field border and the text-selection tint (35% alpha), which are interaction affordances, not content.

### Secondary
- **Dusk Blue** (ontime): on-time flights, the "lowers the probability" direction in Predict factors, the predicted-on-time cells of the confusion matrix, and the carrier cause.
- **Signal Red** (cancelled): cancelled flights and every error message (QueryState error title, field validation text).

### Tertiary
- **NAS Violet** (cause-nas), **Weather Green** (cause-weather), **Security Sand** (cause-security): the remaining delay causes in cause share bars and stacked charts. `cause-late` and `cause-carrier` alias Departure Amber and Dusk Blue.

### Neutral
- **Night Ground** (ground): the page background everywhere, including html, and the text colour on inverted (ink) pills.
- **Warm Ink** (ink): primary text, row headers, figures, active tab text.
- **Ink 2** (ink-2): secondary text, page intros, field labels, inactive tabs, axis-adjacent labels.
- **Ink 3** (ink-3): tertiary text: notes, column heads, rank numbers, chart axis ticks, the data strip.
- **Hairline** (rule): row dividers and section top rules.
- **Strong Hairline** (rule-strong): board header underline, KPI row frame, field and outline-button borders, active tab fill.
- **Wash** (wash): row hover, selected row, segmented track, empty bar tracks.
- **Tooltip Black** (tooltip-surface): the chart tooltip body, with a strong-hairline border.

### Named Rules
**The Lit Column Rule.** Amber means delayed or delay rate. If a value is not about delay, it is not amber; a non-delay share uses the ink tone of RateCell.

**The Paired Encoding Rule.** Delayed versus on time is always amber versus blue, in every chart, gauge, factor bar and matrix.

**The Colour Is Data Rule.** Saturated colour appears only to encode a data category. Chrome, buttons and headings stay in ink.

## Typography

**Display Font:** Instrument Serif (with Times New Roman, serif)
**Body Font:** Geist (with -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif), base weight 300
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo, monospace), tabular figures

**Character:** A condensed editorial serif sets titles and big numbers like a printed timetable, while a light grotesque and a mono with tabular digits keep the working surface precise and quiet.

### Hierarchy
- **Display** (400, clamp(3rem, 9vw, 6rem), 0.98): the intro title only.
- **Headline** (400, clamp(2.25rem, 5vw, 3.25rem), 1): one page title per page (PageHeader), text-balanced, intro paragraph capped at 75ch.
- **Title** (400, 1.5rem, 1.25): section titles above a hairline rule. Sub-blocks use the serif at 1.25rem.
- **Figure** (400, clamp(1.75rem, 3vw, 2.5rem), 1.1, tabular): KPI values and the Predict verdict. Serif figures, never mono.
- **Wordmark** (400, 22px, 1): the top-bar name.
- **Body** (300, 14px, 1.625): intros and explanatory copy, 65ch maximum for notes.
- **UI** (300, 13px): tabs, buttons, factor rows, notes.
- **Label** (300, 12px): field labels, legends, KPI labels (sentence case).
- **Column head** (400, 11px, 0.025em tracking): board column headers in ink-3, sentence case.
- **Data** (400 mono, 13px, tabular): every board cell, sub-figures under KPIs (11px), the data strip (12px), dates and IDs.

### Named Rules
**The Mono Means Measured Rule.** Geist Mono is for figures, dates, codes and IDs. Names (airlines, airports, features) inside a mono board switch back to Geist.

**The Sentence Case Rule.** Labels and column heads are sentence case at 11-12px in ink-2 or ink-3. There are no uppercase eyebrow labels above titles.

## Layout

A single top bar, then one content container (max 1440px, 20px side gutters, 40px from md). Pages are vertical stacks of Sections, each opened by a hairline top rule with 24px above its content, stacked 32-40px apart. Overview and similar pages use a main column plus a fixed 420px side column at lg (`minmax(0,1fr) 420px`, 40px column gap); Predict uses a 420px form column beside a fluid result column; Causes splits 2:3 at lg; Model splits 1:1 at lg.

Boards are full-width tables in a horizontally scrollable wrapper. Rows are 36px; the rank column is 40px and zero-padded ("01"). On small screens secondary columns hide (`hidden sm:table-cell` / `md:table-cell`) and the RateCell bar hides, leaving only the value. The KPI row is a 2x2 grid on mobile and 4 across at lg, separated by hairlines rather than gaps. The hour-by-day heatmap is 24 columns wide at sm and up and rotates to a 7-column layout on mobile.

Breakpoints are Tailwind defaults: sm 640px, md 768px, lg 1024px. The top bar wraps on mobile (tabs become a horizontally scrolling row and the data strip moves to its own line) and becomes a single 64px row at md.

## Elevation & Depth

The system is flat. Depth comes from tonal layering on the ground (wash at 5% white for hover and selection, rule and rule-strong hairlines for structure), never from drop shadows. The only shadow is the inset top highlight of the glass treatment.

### Shadow Vocabulary
- **Glass highlight** (`box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1)`): the Predict panel and its submit button only, together with a 6px backdrop blur and a gradient hairline border masked to the edge.

### Named Rules
**The One Glass Rule.** Glass (the `liquid-glass` treatment) exists only on the Predict panel and its submit button. Every other surface sits flat on the ground.

**The No-Card Rule.** Blocks are divided by hairline rules, not boxed in cards with shadows or fills.

## Shapes

Two shape families. Interactive controls are fully round pills (tabs, segmented controls, outline buttons, chips, the glass submit). Containers that hold input or values are gently rounded: fields and tooltips at 8px, confusion-matrix cells at 6px, the Predict panel at 24px. Data marks are nearly square: swatches and heatmap cells at 2px, skeletons at 3px, bar tracks and rate bars fully rounded. Tables and sections have no radius at all; their edges are hairlines. Cells with no data use a 135-degree hatch (2px white at 14% every 6px) rather than an empty fill.

## Components

### Buttons
Quiet, pill-shaped, ink on ground; never filled with a data colour.
- **Shape:** fully round pill (9999px).
- **Outline (default action, Retry, Load more, Open dashboard):** strong-hairline border, ink text, 13-14px, padding 6px 16px to 12px 28px; hover fills with wash.
- **Text link (secondary):** ink-2 text, hover to ink with a 4px-offset underline.
- **Glass (Predict submit only):** the glass treatment, full width, 14px 24px. Its label names the route ("Score ORD → LAX", codes in mono) with an arrow that slides on hover. Hover brightens to 7% white and warms the edge with an amber hairline and a soft amber underglow; press scales to 98.5%; while scoring, a small ink spinner and "Scoring…"; disabled at 60% opacity.

### Chips
- **Style:** pill with a strong-hairline border, 12px Geist, ink text, padding 4px 12px (used to pick a route in Explorer).
- **State:** pressed (`aria-pressed`) inverts to an ink fill with ground text.

### Segmented control
- **Style:** a wash track (4px padding) holding pill buttons at 13px.
- **State:** the active option inverts to ink fill with ground text; inactive options are ink-2, hovering to ink. Each option is a real button with `aria-pressed`.

### Cards / Containers
- **Corner Style:** none for content blocks; 24px only for the Predict panel.
- **Background:** the ground itself. Sections are a hairline top rule, a serif title, an optional ink-3 note and the content.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Internal Padding:** 24px above section content; the Predict panel pads 24px, 32px from sm.

### Inputs / Fields
- **Style:** native select and date inputs at 14px, strong-hairline border, 8px radius, ground at 60% fill, 10px 36px 10px 12px padding, a drawn 12px chevron in ink-2. Labels sit above at 12px ink-2.
- **Focus:** the border turns amber and the global 2px amber focus ring (3px offset) appears.
- **Flight fields (Predict only, `components/predict/FlightFields.tsx`):** a drawn face over a real native control, so the keyboard, type-to-jump, screen readers and phone pickers behave natively.
  - **Face:** the code in mono (19px on the route fields, 14px elsewhere), the name beside it in Geist, and a quieter 11px detail line (city, or flights in 2015) so nothing truncates mid-number.
  - **Shell:** 12px radius, strong-hairline border over a faint top-lit gradient; hover lifts the hairline.
  - **Focus (`:focus-within`):** the border turns amber with a 3px amber halo at 14% and the chevron warms; the control inside draws no second ring.
  - **Error and disabled:** a Signal Red border (message below as before); disabled at 55%.
  - **Date:** a visible native date input in mono with the browser's calendar icon replaced by a drawn one; a click anywhere opens the platform picker, and the weekday shows beside the label.
- **Error:** `aria-invalid` with a 12px Signal Red message linked by `aria-describedby`.

### Navigation
- **Style:** one top bar with a bottom hairline: serif wordmark at left, five pill tabs (13px), and a right-aligned mono data strip in ink-3 (flight count in ink · date range · stats build date).
- **States:** inactive tabs ink-2, hover ink; the active tab fills with rule-strong and turns ink.
- **Mobile:** the bar wraps; tabs scroll horizontally on their own line and the data strip takes a full-width line. A skip-to-content link appears on focus.

### Departure Board (signature)
A real `<table>` in Geist Mono at 13px with tabular figures. Column heads are 11px Geist in ink-3 over a strong-hairline underline; rows are 36px with a hairline below, wash on hover, and wash on the selected row. An optional zero-padded rank column leads. The row-header column renders as `<th scope="row">` in ink.

**The Lamp.** When rows are re-sorted or refiltered they glide to their new rank in place (layout position, 550ms, ease-out-expo; new rows fade in over 300ms), and every row whose rank changed holds an amber lamp (20% amber background fading to 0 over 1.2s). Under `prefers-reduced-motion` nothing moves and no lamp lights. Paged lists turn animation off.

### RateCell
The lit column: an inline bar (6px tall, wash track, min 40px, scaled to the column maximum, width eased over 500ms) followed by a right-aligned value in mono. Amber for a delay rate; the ink tone (ink-2 bar, ink value) for any other share. The bar hides below sm.

### QueryState
Every API-backed block goes through one wrapper. Loading is a skeleton with a slow sheen (1.6s linear) and a screen-reader "Loading …" status. Errors are a hairline-ruled block: a Signal Red "Could not load …" line, the API message in ink-2, an optional hint in ink-3, and an outline Retry pill. Empty data shows a hairline-ruled ink-2 message.

### KPI rule row
A definition list framed top and bottom by strong hairlines, cells divided by hairlines: a 12px ink-2 label, a serif figure (amber only for the delay rate), and an 11px mono sub-figure in ink-3.

### Predict panel and gauge
The glass panel holds the form; the result sits beside it on the ground. The panel's glass carries a faint amber light at its upper right and a fainter blue one at its lower left (the evening light of the landing globe), and it rises in on load with each field group following at 70ms steps (CSS only; none under reduced motion). The form reads in flight order:
- **Route:** origin over destination, joined by a flight path (an ink ring, a dashed rail, a filled dot) in the gutter. The destination label carries the route count from the origin.
- **Airline**, below a hairline.
- **Date and departure hour** side by side from sm.
- **Submit**, with a one-line reminder that only pre-departure inputs are used. The gauge is a 180-degree arc (12px stroke, rounded caps) filling amber or blue by label, with a white tick and mono label at the decision threshold and the probability set in the serif at 44px; the arc fill transitions over 900ms. Factor bars diverge from a centre hairline: amber raises, blue lowers, values in mono percentage points.

### Charts
Recharts on the ground: horizontal grid lines only (rule), axis ticks 11px ink-3, tooltips on Tooltip Black with a strong-hairline border and 8px radius, no entry animation. Every chart has a `role="img"` label and its numbers also appear in an adjacent table or list.

### Landing (the `/` page only)
**Concept: night orbit over the US.** The dataset is US domestic only, so the camera lives over the lower 48: on desktop they fill the right two thirds, on phones the top half edge to edge, and the globe leans back about the framed point so the horizon curves away at the top. Only the volume chapter pulls back far enough for Alaska and Hawaii, and only the model and hand-off chapters show the planet. Everything drawn is real data; nothing is decorative geometry.
- **Geography:** US coast, land borders and state lines are 1:10M Census line work (`us-atlas`; outline in ink at 46%, states at 12%). US land is lifted out of the night by a fill texture. Other coasts are 110m Natural Earth (`world-atlas`) and, with other land and the 15-degree graticule, fade with angular distance from the US.
- **Airport columns:** every airport with 2,000+ departures in 2015 rises as a column. The data is `/api/analytics/delay-rate?by=origin`, both ends of the ranking; they overlap, so the list is complete. Height is departures, linear (ATL is the tallest). Colour is the delay rate against the national rate from `/api/analytics/summary`: warm ink at the national rate, ramping to Dusk Blue 8 points below and Departure Amber 8 points above. The columns grow in from the west coast eastward. Every other airport in airports.csv is a warm city light.
- **Route arcs:** from the delay-rate ranking (`/api/analytics/delay-rate?by=route`, at least 1,000 flights): the 10 most often late in Departure Amber and the 10 most punctual in Dusk Blue.
- **Moving lights:** each arc carries one light per 1,000 scheduled 2015 flights (1 to 14), all at one ground speed, so a busier route visibly carries more traffic.
- **Map key** (top right, under the controls on desktop): column height, the colour ramp with its three real thresholds, and the moving-light rule. It shows only once its figures load, and steps aside while a details panel is open.

**Scroll story.** Six full-viewport chapters, each a serif title over Geist body copy at 15px (one step above Body for projector legibility), all left-aligned on desktop and low on phones:
1. Hero: title, live flight count, the KPI rule row with captions, the two actions.
2. Volume: flights, airports and airlines from `/api/meta`, plus the date range in mono.
3. Routes: two five-row departure boards (most often late, most punctual) beside the arcs.
4. Predict: the five inputs as pills, and the tuned threshold from `/api/model/metrics`.
5. Model: test ROC-AUC for baseline, logistic regression and LightGBM. The served model is in ink, the others in ink-3.
6. Hand-off: "Continue to the dashboard" at display size over a hairline-ruled board of the five pages (two columns below lg, the last spanning both; five from lg). Each link carries:
   - the page name in the serif (link-title) and a blurb (from sm);
   - an arrow chip that turns upright and fills with ink on hover or focus;
   - one live figure with a caption: the delay rate (amber), the largest cause's share of delay minutes (in its cause colour), the flight count, the tuned threshold, and the served model's test ROC-AUC.

   A hairline draws across the top of the hovered link. A loading figure is a skeleton; a failed one is simply left out.

The globe re-frames per chapter (pose table in `GlobeScene.tsx`: facing lat/lon, size and offset as fractions of the viewport, tilt, and arc, airport and column brightness), eased with smoothstep between chapters and damped per frame. The volume and predict chapters bring the columns up; the routes chapter steps them back so the arcs read.

**Globe material.**
- **Lighting:** a sun fixed in view space (low right, slightly behind) puts the country in early evening: a soft terminator past the east coast, a faint glint on the water, and a rim that warms where the sun meets the limb.
- **Ambient floor:** a hemisphere term in view space (cool from above, faintly warm from below) lifts sea and land on the night side, so the globe never goes black at any angle.
- **Emissive coasts:** the land texture's blue channel holds a soft glow along every shoreline, so continents read even unlit. Antimeridian and polar cut edges are skipped.
- **Surface:** land carries a whisper of grain so large fills read as surface, not flat paint.
- **Atmosphere:** an inner haze at grazing angles and an outer halo. Both keep a floor on the night side and brighten toward the sun, so the rim glow is continuous all round.
- **Line work:** coastlines, state lines and the graticule are brighter on the lit hemisphere but never drop below 72% of their alpha. Away from the US they keep at least 60%.
- **Airports:** city lights brighten on the night side.
- **Route endpoints:** pulsing rings in their routes' colour, which blends amber and blue when an airport anchors both kinds (warm ink for a selected airport's network).
- **Arcs:** each is a thin core with a comet trail and a white-hot head, inside a soft halo tube, so it glows with no post-processing pass.
- **Aircraft:** one per arc, an instanced swept-wing silhouette, rides the pulse head along the great circle. The shader and the CPU share one pulse formula (`shaders.pulseHead`).

**Interaction.**
- **Hover:** hovering an arc, a column or an airport light on the globe (fine pointers) shows a tooltip at the cursor. A route shows its delay rate. An airport shows its code, name and city, plus departures and delay rate when it has a column.
- **Board hover:** pointing at a board row lights its arc, dims the rest and turns the globe to face the route.
- **Selection:** clicking an arc or a board row selects the route. The globe flies to it, framed by route length (closer for a short hop), and the "Selected route" panel opens. The panel shows:
  - the route's rank;
  - origin and destination cities;
  - the delay rate as a Figure, with its completed-flight base;
  - average arrival delay, scheduled flights and great-circle miles (computed from airports.csv coordinates);
  - "Score a flight", which opens Predict prefilled through `?origin=&dest=`.

  Escape, the close button or a click on open ground clears it, and so does a new chapter.
- **Airport selection:** clicking (or tapping) a column selects its airport.
  - Its 12 busiest destinations from `/api/routes` fan out as warm-ink arcs with moving lights; ranked routes that do not touch it dim; the camera frames the airport and its network.
  - The "Selected airport" panel shows the delay rate as a Figure (amber above the national rate, blue below) with its completed-departure base, departures, average arrival delay, the gap to the national rate in points, and a destination board (flights, with an ink bar).
  - Pointing at a board row lights its arc without turning the globe; each row opens Predict prefilled.
  - A route and an airport are never selected together.
- **Controls:**
  - **Drag:** rotates the globe.
  - **Ctrl/Cmd + wheel:** zooms (0.7 to 2.2x). A plain wheel always scrolls the page.
  - **Double-click:** zooms in, or resets once zoomed far.
  - **Controls cluster** (top right, desktop): zoom in, zoom out and reset, each a labelled button.
- **Idle:** after 2.6 s without input, a drag eases back to the chapter framing. There is no free rotation. Every chapter sways around the US, with a slower, smaller latitude drift, so the swing reads as natural and the data never turns out of view. One swing takes about 70 s. Amplitudes:
  - 3 to 5 degrees in the close US chapters;
  - 14 degrees in the model chapter;
  - 22 degrees in the hand-off, where the whole planet shows.

**Camera.**
- **Lens:** a 16-degree field of view, so the camera stands back and the country stays true to shape when it fills the frame. Selections are framed no closer than size 2.9.
- **Establishing shot:** on load, the camera starts on the whole planet, turned toward the Pacific, and descends onto the US over 3.4 s, tipping into its lean as it lands.
- **Cursor bank:** the view banks up to 2 degrees with the cursor.
- **Perspective aim:** an outer group always aims the faced point at the camera, so it lands exactly where the pose puts it. With the globe off-centre and the camera close, the camera-facing point is not the middle of the visible disc.
- **Lean:** a tilt group pivots about the faced surface point, so the framing holds while the globe leans back (0 to 44 degrees by chapter).
- **Shared uniforms:** React Three Fiber copies each uniform object passed in `uniforms`. The per-frame ones (`shaders.LIVE`: time, and arc, airport and column brightness) are therefore re-linked onto every material with `linkLive` in its ref.

**Constraints.**
- **Eager path:** no three.js and no Motion. The copy, figures and entrance render first.
- **Lazy chunks** load once the browser is idle: the globe (`globe/GlobeScene.tsx`: three, React Three Fiber, world-atlas, us-atlas) and the Motion layer (`landing/enhance.ts`). Colours the eager map key shares with the globe live in `globe/palette.ts`, which imports nothing.
- **Shared state:** scroll and pointer reach the globe through a render-free store (`globe/store.ts`), never React state.
- **No WebGL:** an error boundary leaves the copy on the night ground.
- **Under `prefers-reduced-motion`:**
  - the globe is one still frame (`frameloop="demand"`), redrawn instantly on any hover, selection, drag or zoom;
  - there is no establishing shot, sway, auto-rotation, pulse, aircraft, moving lights, ring pulse, arc draw-in, column grow-in, camera bank, scroll re-framing or reveal, and the map key drops its moving-light line;
  - visitor-driven drag and zoom still work, but they snap instead of easing;
  - the Motion chunk is never requested.

## Do's and Don'ts

### Do:
- **Do** show rankings and breakdowns as departure boards: fixed tabular columns, Geist Mono tabular figures, 36px rows, hairline dividers.
- **Do** use Departure Amber (#e8a54b) only for delayed flights or delay rates, and pair it with Dusk Blue (#7c9bd1) for on time.
- **Do** separate blocks with hairline rules (rgba(255,255,255,0.08)) and a serif section title.
- **Do** set page titles, section titles and headline figures in Instrument Serif at weight 400.
- **Do** keep Geist Mono for figures, dates, codes and IDs, and switch names back to Geist.
- **Do** wrap every API-backed block in QueryState so it has loading, error-with-Retry and empty states.
- **Do** honour `prefers-reduced-motion`: no glide, no lamp, no rise, near-zero transitions, and a still globe.
- **Do** use the 2px amber focus ring (3px offset) for every interactive element.

### Don't:
- **Don't** build card grids of identical chart tiles or put content in shadowed cards.
- **Don't** use amber for anything that is not about delay (decoration, headings, generic highlights, buttons).
- **Don't** use the glass treatment anywhere except the Predict panel and its submit button.
- **Don't** set prose, names or headings in Geist Mono.
- **Don't** add uppercase eyebrow labels above titles; labels are sentence case.
- **Don't** add drop shadows; the only shadow is the glass inset highlight.
- **Don't** show any number the API does not provide.
