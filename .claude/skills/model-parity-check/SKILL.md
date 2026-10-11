---
name: model-parity-check
description: Run the full model pipeline (export, train, register) and verify the TypeScript ONNX inference matches Python, with no leakage and metrics beating baseline. Use after any change to features, training, encoders or the predict service, or before quoting model metrics.

---
# Model pipeline and parity check

1. **Prereqs**: data loaded (`/verify-ingestion` passes), `delay_lookup` built (`npm run build:lookup`), Python deps installed (`pip install -r ml/requirements.txt`, in a venv).
2. **Run**: `npm run export:training`, `python ml/train.py`, `npm run ml:register`.
3. **Parity data**: `train.py` must write `ml/artifacts/parity_sample.json` with 100 fixed-seed test rows (raw feature values plus Python's predicted probability). If it does not, add that.
4. **Parity test**: `server/tests/parity.test.ts` loads `model.onnx` through the real TS encoder and predictor, runs the 100 rows, and asserts `|p_ts - p_py| < 1e-4` for each. Create it if missing. Run `npm test -- parity`.
5. **Leakage test**: an automated test that reads `encoders.json` and fails if any forbidden feature (depDelay, taxiOut, taxiIn, airTime, arrDelay, elapsedTime, causes*, cancelled, diverted) is in the feature list. Create it if missing.
6. **Delegate** the `leakage-auditor` agent for a full audit. Fix anything it marks FAIL.
7. **Report**: baseline vs chosen model (ROC-AUC, precision, recall, F1 at the chosen threshold, confusion matrix), delay-rate imbalance, top 10 feature importances, parity max error. Quote numbers from `metrics.json` only. If test AUC is above ~0.75, treat it as a suspected leak, not a win.
