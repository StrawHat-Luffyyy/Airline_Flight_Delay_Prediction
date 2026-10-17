---
version: 1
slug: "src-components-landing-landing-tsx"
primary_target: "src/components/landing/Landing.tsx"
related_targets: ["src/components/globe/GlobeScene.tsx", "src/components/landing/Chapters.tsx", "src/components/landing/Hero.tsx"]
---

# Landing (`/`): night orbit

Scope: the `/` route only, in front of the five dashboard pages. Visitor mode: Persuade. The examiner should believe that the data is real and large, and that it has been analysed and modelled honestly, and then open the dashboard.
Audience: examiners at a viva or demo, driven by the author on a laptop or projector.
Content: live API only (`/api/meta`, `/api/analytics/summary`, `/api/analytics/delay-rate?by=route`, `/api/model/metrics`). Every chapter has loading and error states.

## Direction contract

THESIS: The dataset is the visual. A night globe shows the real airports and the real routes that run most often late and most punctual. Scrolling through volume, routes, prediction and evaluation re-frames the globe. This refuses a stock-video hero and a grid of feature cards.

OWN-WORLD: This is the dashboard's world, unchanged: the #010101 ground, warm ink, Instrument Serif titles, Geist UI and Geist Mono figures. Amber always means late and blue always means punctual. The landing adds atmosphere colours of its own: limb #a9b8cc and city-light #ffe9c4. There is no glass and there are no cards; blocks sit on hairline rules.

STORY: The hero's live count leads into the volume chapter (5.8M flights, airports, airlines). The routes chapter shows departure boards linked to the arcs. Predict states the inputs and the tuned threshold. Model gives the test ROC-AUC against baseline and logistic regression. The hand-off links to the dashboard.

FIRST VIEWPORT: Left: the two-line serif title, the live subline, the KPI rule row and the two actions. Right: the globe facing North America, its arcs drawing in.

FORM: A fixed WebGL stage behind six full-viewport chapters. Signature move: pointing at a board row turns the globe to that route and lights it, and hovering an arc lights it in place. Selecting either flies the camera in and opens its real figures, one click from Predict prefilled.

FINISH: Verified in the browser at 1024 and 1440 px and on mobile at 375 px, and under reduced motion in Playwright. DESIGN.md "Landing" holds the durable rules.
