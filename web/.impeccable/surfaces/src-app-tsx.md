---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Dashboard (Overview, Causes, Explorer, Predict, Model) + compact intro

Scope: the whole web app shell and its five §10 pages, plus a compact intro in front of them. Visitor mode: Operate (the intro is a short Persuade moment that hands off to Overview).
Audience: examiners at a viva/demo, driven by the author on a laptop or projector. Task: follow volume -> analysis -> prediction -> honest evaluation without any number being questioned.
Content: live API only (`/api/meta`, `/api/analytics/*`, `/api/flights`, `/api/predict`, `/api/model/*`); loading and error states on every fetch.

## Direction contract

THESIS: Every ranking is a departure board. Airlines, airports, routes and months are rows in fixed tabular columns, with the delay rate as the lit amber column. This refuses the category default of a grey card grid of identical chart tiles.

OWN-WORLD: The ground is near-black #010101. Ink is #f2f1ec, stepped by opacity. Instrument Serif carries page titles and headline figures; Geist carries the UI; Geist Mono with tabular figures carries board rows. The dusk palette encodes data: amber #e8a54b = delayed or delay rate, blue #7c9bd1 = on time, red #d0614a = cancelled, violet #9a8fc4 = NAS, green #5fa38a = weather. Hairline rules and no card shadows. One glass treatment is reserved for the Predict panel.

STORY: The visitor sees the dataset's scale in the persistent data strip and understands where delays concentrate and why. They score one flight, then see the model's honest test metrics.

FIRST VIEWPORT: There is one top bar: the wordmark, the five page tabs, and on the right a mono data strip (flight count · date range · stats build date). Overview shows the title, a four-KPI rule row, and the 12-month board with an inline delay-rate bar and train/test split column; a right column holds the worst-airlines board and the cause share bar.

FORM: Departure board, dealt position 4 of 7, seed d59af782. Signature move: when a board re-sorts or refilters, rows move to their new rank in place, and changed rows hold an amber lamp for a moment (none under reduced motion).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
