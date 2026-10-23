"""Offline training for the flight delay model (PROJECT_OVERVIEW section 7).

The only non-TypeScript file in the project. Reads data/export/{train,test}.csv written by
`npm run export:training`, trains a baseline, logistic regression and LightGBM, and writes
ml/artifacts/{model.onnx, encoders.json, metrics.json, parity_sample.json}.

Evaluation rules (docs/DECISIONS.md, Phase 4):
- time-based split: train = Jan-Sep, test = Oct-Dec (the `split` column);
- September is held out of train for early stopping, threshold choice and model selection;
  the test set is only ever scored, never used to choose anything;
- the decision threshold maximises F1 on the validation precision-recall curve.

Usage: ml/.venv/Scripts/python ml/train.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import lightgbm as lgb
import numpy as np
import onnxruntime as ort
import pandas as pd
from onnxmltools import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType as SklFloatTensorType
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
EXPORT_DIR = ROOT / "data" / "export"
ARTIFACTS = ROOT / "ml" / "artifacts"

# Must equal server/src/features/feature-list.ts (FEATURE_COLUMNS); checked against the CSV header.
FEATURES = [
    "dayOfWeek",
    "schedDepHour",
    "isHolidayWeek",
    "airline",
    "origin",
    "dest",
    "distance",
    "scheduledTime",
    "airlineRate",
    "originRate",
    "destRate",
    "originHourRate",
    "routeRate",
]
CATEGORICAL = ["airline", "origin", "dest"]
NUMERIC = [f for f in FEATURES if f not in CATEGORICAL]
FORBIDDEN = {
    "depDelay", "taxiOut", "taxiIn", "airTime", "arrDelay", "elapsedTime",
    "causes", "cancelled", "diverted",
}
UNKNOWN_CODE = -1
VALIDATION_MONTH = 9
SEED = 2015
PARITY_ROWS = 100
ONNX_TOLERANCE = 1e-4


FORBIDDEN_STEMS = ("depdelay", "taxiout", "taxiin", "airtime", "arrdelay", "elapsedtime", "cause", "cancel", "divert")


def is_forbidden(name: str) -> bool:
    """Same rule as isForbiddenFeature in server/src/features/feature-list.ts."""
    lower = name.lower()
    return lower in {f.lower() for f in FORBIDDEN} or any(stem in lower for stem in FORBIDDEN_STEMS)


def log(message: str) -> None:
    print(f"[train {time.strftime('%H:%M:%S')}] {message}", flush=True)


def load(path: Path, keep_id: bool) -> pd.DataFrame:
    header = pd.read_csv(path, nrows=0).columns.tolist()
    expected = ["id", "split", "month", "label", *FEATURES]
    if header != expected:
        sys.exit(f"{path.name}: header {header} != feature contract {expected}")
    leaked = [c for c in header if is_forbidden(c)]
    if leaked:
        sys.exit(f"{path.name}: forbidden feature columns {leaked}")
    dtypes = {c: "float32" for c in NUMERIC} | {c: "category" for c in CATEGORICAL}
    dtypes |= {"label": "int8", "split": "category", "month": "int8"}
    usecols = expected if keep_id else expected[1:]
    return pd.read_csv(path, usecols=usecols, dtype=dtypes | ({"id": "string"} if keep_id else {}))


def build_encoders(train: pd.DataFrame) -> dict[str, dict[str, int]]:
    """Category -> integer, from training codes only (sorted for stability); unseen -> UNKNOWN_CODE."""
    return {c: {code: i for i, code in enumerate(sorted(train[c].astype(str).unique()))} for c in CATEGORICAL}


def encode(df: pd.DataFrame, encoders: dict[str, dict[str, int]], imputation: dict[str, float]) -> np.ndarray:
    columns = []
    for feature in FEATURES:
        if feature in CATEGORICAL:
            codes = df[feature].astype(str).map(encoders[feature]).fillna(UNKNOWN_CODE)
            columns.append(codes.to_numpy(dtype=np.float32))
        else:
            values = df[feature]
            if feature in imputation:
                values = values.fillna(imputation[feature])
            columns.append(values.to_numpy(dtype=np.float32))
    return np.column_stack(columns).astype(np.float32)


def best_f1_threshold(y: np.ndarray, p: np.ndarray) -> float:
    precision, recall, thresholds = precision_recall_curve(y, p)
    f1 = np.divide(2 * precision * recall, precision + recall, out=np.zeros_like(precision), where=(precision + recall) > 0)
    return float(thresholds[int(np.argmax(f1[:-1]))])


def evaluate(y: np.ndarray, p: np.ndarray, threshold: float | None) -> dict:
    predicted = (p >= threshold).astype(int) if threshold is not None else np.zeros_like(y)
    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    return {
        "auc": float(roc_auc_score(y, p)) if len(np.unique(p)) > 1 else 0.5,
        "prAuc": float(average_precision_score(y, p)),
        "precision": float(precision_score(y, predicted, zero_division=0)),
        "recall": float(recall_score(y, predicted, zero_division=0)),
        "f1": float(f1_score(y, predicted, zero_division=0)),
        "threshold": threshold,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def lgbm(n_estimators: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        n_estimators=n_estimators,
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=200,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        random_state=SEED,
        deterministic=True,
        force_row_wise=True,
        n_jobs=-1,
        verbose=-1,
    )


def logistic() -> Pipeline:
    numeric_idx = [FEATURES.index(f) for f in NUMERIC]
    return Pipeline([
        ("scale", ColumnTransformer([("numeric", StandardScaler(), numeric_idx)], remainder="drop")),
        ("model", LogisticRegression(max_iter=1000, random_state=SEED)),
    ])


def to_onnx(model, algorithm: str) -> bytes:
    n = len(FEATURES)
    if algorithm == "lightgbm":
        onx = convert_lightgbm(model, initial_types=[("features", FloatTensorType([None, n]))], zipmap=False)
    else:
        onx = convert_sklearn(
            model,
            initial_types=[("features", SklFloatTensorType([None, n]))],
            options={id(model.named_steps["model"]): {"zipmap": False}},
        )
    # The converters declare the `label` output as shape [1]; it has one value per input row.
    for output in onx.graph.output:
        if output.name == "label":
            dims = output.type.tensor_type.shape.dim
            del dims[:]
            dims.add().dim_param = "N"
    return onx.SerializeToString()


def onnx_probability(session: ort.InferenceSession, x: np.ndarray) -> np.ndarray:
    """P(delayed) from the `probabilities` output (column 1), the contract /predict uses."""
    return session.run(["probabilities"], {"features": x})[0][:, 1]


def main() -> None:
    started = time.time()
    manifest = json.loads((EXPORT_DIR / "manifest.json").read_text())
    log(f"loading {manifest['trainRows']:,} train / {manifest['testRows']:,} test rows")
    train = load(EXPORT_DIR / "train.csv", keep_id=False)
    test = load(EXPORT_DIR / "test.csv", keep_id=True)
    assert len(train) == manifest["trainRows"] and len(test) == manifest["testRows"], "row count mismatch"
    assert set(train["split"].unique()) == {"train"} and set(test["split"].unique()) == {"test"}
    assert train["month"].max() <= 9 and test["month"].min() >= 10, "time split violated"

    encoders = build_encoders(train)
    imputation = {"scheduledTime": float(train["scheduledTime"].median())}
    x_train, y_train = encode(train, encoders, imputation), train["label"].to_numpy()
    x_test, y_test = encode(test, encoders, imputation), test["label"].to_numpy()
    fit_mask = (train["month"] != VALIDATION_MONTH).to_numpy()
    x_fit, y_fit = x_train[fit_mask], y_train[fit_mask]
    x_val, y_val = x_train[~fit_mask], y_train[~fit_mask]
    log(f"fit {len(y_fit):,} rows (Jan-Aug), validation {len(y_val):,} rows (Sep), test {len(y_test):,}")

    results: dict[str, dict] = {}

    # Baseline: always predict the training delay rate (and the majority class, on time).
    base_rate = float(y_train.mean())
    results["baseline"] = {
        "description": "constant probability = train delay rate; predicts the majority class (on time)",
        "validation": evaluate(y_val, np.full(len(y_val), base_rate), None),
        "test": evaluate(y_test, np.full(len(y_test), base_rate), None),
    }

    # Logistic regression on the scaled numeric features (categorical codes are not ordinal).
    log("logistic regression")
    lr_fit = logistic().fit(x_fit, y_fit)
    lr_val = lr_fit.predict_proba(x_val)[:, 1]
    lr_threshold = best_f1_threshold(y_val, lr_val)
    lr_final = logistic().fit(x_train, y_train)
    results["logisticRegression"] = {
        "validation": evaluate(y_val, lr_val, lr_threshold),
        "test": evaluate(y_test, lr_final.predict_proba(x_test)[:, 1], lr_threshold),
        # The Jan-Aug model the threshold was chosen on, scored on test at that same threshold.
        "testFitModel": evaluate(y_test, lr_fit.predict_proba(x_test)[:, 1], lr_threshold),
    }

    # LightGBM with early stopping on September, then refit on Jan-Sep with the best iteration count.
    log("lightgbm (early stopping on September)")
    gbm_fit = lgbm(3000).fit(
        x_fit, y_fit, eval_X=x_val, eval_y=y_val, eval_metric="auc",
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )
    best_iteration = int(gbm_fit.best_iteration_ or gbm_fit.n_estimators)
    gbm_val = gbm_fit.predict_proba(x_val, num_iteration=best_iteration)[:, 1]
    gbm_threshold = best_f1_threshold(y_val, gbm_val)
    log(f"lightgbm refit on Jan-Sep with {best_iteration} trees")
    gbm_final = lgbm(best_iteration).fit(x_train, y_train)
    results["lightgbm"] = {
        "bestIteration": best_iteration,
        "validation": evaluate(y_val, gbm_val, gbm_threshold),
        "test": evaluate(y_test, gbm_final.predict_proba(x_test)[:, 1], gbm_threshold),
        "testFitModel": evaluate(
            y_test, gbm_fit.predict_proba(x_test, num_iteration=best_iteration)[:, 1], gbm_threshold
        ),
    }

    # Model selection on validation AUC only.
    candidates = {"logisticRegression": lr_final, "lightgbm": gbm_final}
    chosen = max(candidates, key=lambda name: results[name]["validation"]["auc"])
    model = candidates[chosen]
    threshold = results[chosen]["validation"]["threshold"]
    algorithm = "lightgbm" if chosen == "lightgbm" else "logistic_regression"
    log(f"chosen on validation AUC: {chosen}")

    # ONNX export, checked against the native model on the whole test set.
    onnx_bytes = to_onnx(model, algorithm)
    session = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    native_test = model.predict_proba(x_test)[:, 1]
    onnx_test = onnx_probability(session, x_test)
    onnx_max_diff = float(np.max(np.abs(onnx_test - native_test)))
    assert onnx_max_diff < ONNX_TOLERANCE, f"ONNX differs from native model by {onnx_max_diff}"

    if algorithm == "lightgbm":
        gain = gbm_final.booster_.feature_importance(importance_type="gain")
    else:
        coefs = np.zeros(len(FEATURES))
        coefs[[FEATURES.index(f) for f in NUMERIC]] = np.abs(lr_final.named_steps["model"].coef_[0])
        gain = coefs
    importance = sorted(
        ({"feature": f, "importance": float(g / gain.sum())} for f, g in zip(FEATURES, gain)),
        key=lambda item: item["importance"],
        reverse=True,
    )

    created = datetime.now(timezone.utc)
    model_version = f"{algorithm}-{created:%Y%m%d%H%M%S}-{hashlib.sha256(onnx_bytes).hexdigest()[:8]}"
    test_metrics = results[chosen]["test"]

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # Computed for the previous run; `--operating-points` recomputes them for this one.
    (ARTIFACTS / "operating-points.json").unlink(missing_ok=True)
    (ARTIFACTS / "model.onnx").write_bytes(onnx_bytes)
    encoders_doc = {
        "modelVersion": model_version,
        "algorithm": algorithm,
        "featureOrder": FEATURES,
        "categorical": encoders,
        "unknownCategoryCode": UNKNOWN_CODE,
        "imputation": imputation,
        "lookupScope": "full",
        "threshold": threshold,
        "onnx": {"input": "features", "inputType": "float32", "probabilityOutputColumn": 1},
    }
    (ARTIFACTS / "encoders.json").write_text(json.dumps(encoders_doc, indent=2) + "\n")

    rng = np.random.default_rng(SEED)
    rows = np.sort(rng.choice(len(test), size=PARITY_ROWS, replace=False))
    parity = [
        {
            "id": str(test["id"].iloc[i]),
            "raw": {f: (str(test[f].iloc[i]) if f in CATEGORICAL else float(test[f].iloc[i])) for f in FEATURES},
            "encoded": [float(v) for v in x_test[i]],
            "probability": float(onnx_test[i]),
        }
        for i in rows
    ]
    (ARTIFACTS / "parity_sample.json").write_text(
        json.dumps({"modelVersion": model_version, "seed": SEED, "rows": parity}, indent=2) + "\n"
    )

    metrics = {
        "modelVersion": model_version,
        "createdAt": created.isoformat(),
        "algorithm": algorithm,
        "featureList": FEATURES,
        "trainRange": {"from": "2015-01-01", "to": "2015-09-30", "rows": int(len(y_train))},
        "validation": {"month": VALIDATION_MONTH, "rows": int(len(y_val)), "usedFor": "early stopping, threshold, model selection"},
        "testRange": {"from": "2015-10-01", "to": "2015-12-31", "rows": int(len(y_test))},
        "excluded": {
            "unresolvedAirport": manifest["excludedUnresolvedAirport"],
            "noOutcome": manifest["excludedNoOutcome"],
        },
        "classBalance": {"trainDelayRate": base_rate, "testDelayRate": float(y_test.mean())},
        "threshold": {"value": threshold, "chosenOn": "validation (September)", "criterion": "max F1 on the PR curve"},
        "metrics": test_metrics,
        "models": results,
        "featureImportance": importance,
        "onnx": {"maxAbsDiffVsNative": onnx_max_diff, "rowsChecked": int(len(y_test)), "sizeBytes": len(onnx_bytes)},
        "durationSeconds": round(time.time() - started, 1),
        "versions": {p: version(p) for p in ["lightgbm", "scikit-learn", "onnxruntime", "onnxmltools", "skl2onnx", "numpy", "pandas"]},
    }
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    log(
        f"done in {metrics['durationSeconds']} s: {chosen} test AUC {test_metrics['auc']:.4f} "
        f"(baseline {results['baseline']['test']['auc']:.4f}), threshold {threshold:.4f}, "
        f"onnx max diff {onnx_max_diff:.2e}, model {len(onnx_bytes) / 1e6:.2f} MB"
    )


OPERATING_SHARES = (0.10, 0.20, 0.30, 0.50)


def operating_point(y: np.ndarray, flagged: np.ndarray, base_rate: float) -> dict:
    tp = int(np.sum(flagged & (y == 1)))
    n_flagged = int(flagged.sum())
    precision = tp / n_flagged if n_flagged else 0.0
    return {
        "flagged": n_flagged,
        "flaggedShare": n_flagged / len(y),
        "precision": precision,
        "recall": tp / int(y.sum()),
        "lift": precision / base_rate,
    }


def operating_points() -> None:
    """
    `python ml/train.py --operating-points`: what the SERVED run would gain at other cut-offs, on
    September validation only (no test data). Writes ml/artifacts/operating-points.json and changes
    no model file or threshold.

    No validation probabilities were saved, and the served model was refit on Jan-Sep, so its own
    September scores are in-sample. The honest scores are those of the Jan-Aug model the threshold
    was chosen on: refit here with the run's parameters, seed and best iteration (deterministic),
    and accepted only if its confusion at the deployed threshold equals the recorded one exactly.
    """
    started = time.time()
    run = json.loads((ARTIFACTS / "metrics.json").read_text())
    if run["algorithm"] != "lightgbm":
        sys.exit("operating points are implemented for a lightgbm run only")
    train = load(EXPORT_DIR / "train.csv", keep_id=False)
    encoders = build_encoders(train)
    imputation = {"scheduledTime": float(train["scheduledTime"].median())}
    x_train, y_train = encode(train, encoders, imputation), train["label"].to_numpy()
    fit_mask = (train["month"] != VALIDATION_MONTH).to_numpy()
    x_fit, y_fit = x_train[fit_mask], y_train[fit_mask]
    x_val, y_val = x_train[~fit_mask], y_train[~fit_mask]

    best_iteration = run["models"]["lightgbm"]["bestIteration"]
    log(f"refit Jan-Aug lightgbm with {best_iteration} trees to reproduce September scores")
    p_val = lgbm(best_iteration).fit(x_fit, y_fit).predict_proba(x_val)[:, 1]
    threshold = run["threshold"]["value"]
    recorded = run["models"]["lightgbm"]["validation"]
    check = evaluate(y_val, p_val, threshold)
    reproduced = check["confusion"]
    # The confusion pins the scores at one threshold; AUC and PR-AUC pin their whole ranking.
    if (
        reproduced != recorded["confusion"]
        or abs(check["auc"] - recorded["auc"]) > 1e-9
        or abs(check["prAuc"] - recorded["prAuc"]) > 1e-9
    ):
        sys.exit(f"September scores not reproduced: {check} != recorded {recorded}")

    base_rate = float(y_val.mean())
    order = np.argsort(-p_val, kind="stable")
    points = []
    for share in OPERATING_SHARES:
        k = int(round(share * len(y_val)))
        flagged = np.zeros(len(y_val), dtype=bool)
        flagged[order[:k]] = True
        points.append({"rule": f"top {round(share * 100)}%", "minScore": float(p_val[order[k - 1]]), **operating_point(y_val, flagged, base_rate)})
    deployed = {"rule": "deployed threshold", "minScore": threshold, **operating_point(y_val, p_val >= threshold, base_rate)}

    out = {
        "modelVersion": run["modelVersion"],
        "computedOn": "validation (September)",
        "scores": (
            "Jan-Aug LightGBM the threshold was chosen on (refit, seed and best iteration of the run). "
            "Slightly optimistic, as all validation figures: its training rows carry out-of-fold rates "
            "whose folds include September labels"
        ),
        "reproduced": {"confusion": reproduced, "auc": check["auc"], "prAuc": check["prAuc"]},
        "rows": int(len(y_val)),
        "baseRate": base_rate,
        "deployed": deployed,
        "points": points,
        "durationSeconds": round(time.time() - started, 1),
    }
    (ARTIFACTS / "operating-points.json").write_text(json.dumps(out, indent=2) + "\n")
    log(f"operating points written in {out['durationSeconds']} s (September confusion, AUC and PR-AUC reproduced)")


if __name__ == "__main__":
    operating_points() if "--operating-points" in sys.argv[1:] else main()
