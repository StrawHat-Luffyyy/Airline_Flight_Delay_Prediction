# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
The primary audience is the examiners of a college Big Data subject project, at a live demo or viva. In a few minutes they need to see the story: a large flight dataset was ingested and stored in MongoDB, analysed with aggregation pipelines, and used to train and serve a delay-prediction model. The demo is driven by the project author on a laptop, sometimes on a projector.

## Product Purpose
"Flight Delay Prediction" (plain project name; the AI Studio "Holding Pattern" name is dropped) has three jobs:
- **Explain** US flight delays in 2015: their causes and where and when they concentrate.
- **Predict** whether a flight will arrive 15+ minutes late, using only pre-departure information.
- **Show how good that model really is.**

Success means an examiner can follow the data → analytics → model story without the presenter apologising for any number.

## Positioning
Every figure comes from the project's own pipeline over the real dataset (about 5.8M flights in MongoDB, pre-aggregated `stats_*` collections and a LightGBM model served through ONNX). It does not assert anything the pipeline cannot back up. The model's modest accuracy (test ROC-AUC about 0.63) is shown honestly, with the reason for the ceiling, not hidden.

## Operating Context
- **Running:** the app runs locally (Docker MongoDB, Express API on :3001, Vite on :5173). There are no paid or external services and no LLM calls.
- **Data:** the dataset is 2015 only. The time-based split is train Jan-Sep and test Oct-Dec.
- **Pages** (PROJECT_OVERVIEW §10):
  - Overview;
  - Causes;
  - Explorer;
  - Predict: inputs are date, airline, origin, destination and scheduled departure hour;
  - Model.
- **Landing:** a night-orbit globe of real routes behind a short scroll story (volume, routes, prediction, honest evaluation) that hands off to the pages.

## Capabilities and Constraints
- All data comes from the Express API (`/api/meta`, `/api/analytics/*`, `/api/flights`, `/api/predict`, `/api/model/*`). Types come from `@flight-delay/shared` zod schemas.
- Every data-fetching component needs loading and error states.
- `/predict` returns a probability, a label against a tuned threshold (about 0.207, not 0.5), and occlusion-based top factors for the five historical-rate features. It does **not** return expected delay minutes or per-flight causes.
- **Cause minutes** are only reported for flights that arrived 15+ minutes late.
- **Cancelled and diverted flights** have no arrival delay.

## Evidence on Hand
- Live API data over the ingested dataset.
- `ml/artifacts/metrics.json`: baseline vs logistic regression vs LightGBM, confusion matrix and feature importance.
- `docs/DECISIONS.md` and `docs/EXPLAIN_RESULTS.md`.
- Airport coordinates from airports.csv (via `/api/meta`) and 110m Natural Earth coastlines (the `world-atlas` package, public domain) for the landing globe.

The product has no FAA or NOAA data, no testimonials, no contact address and no expected-minutes prediction; none of these may be invented.

## Product Principles
1. Real numbers only: if the API can't provide it, the UI doesn't show it.
2. Tell the Big Data story in order: volume → analysis → prediction → honest evaluation.
3. Demo-proof: every page loads fast from pre-aggregated data and fails gracefully.
4. Honest uncertainty: show probabilities and thresholds, not verdicts dressed as certainty.

## Accessibility & Inclusion
- **Visibility:** the app must stay legible on a projector.
- **Motion:** respect `prefers-reduced-motion`. The incumbent code already does.
- **Keyboard:** every control must be keyboard-operable.
