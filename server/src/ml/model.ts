import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { FEATURE_COLUMNS } from '../features/feature-list.js';
import { loadEncoders, type Encoders } from './encoders.js';

export const DEFAULT_ARTIFACTS_DIR = fileURLToPath(
  new URL('../../../ml/artifacts', import.meta.url),
);

const PROBABILITIES_OUTPUT = 'probabilities';

/** The deployed model: ml/artifacts/model.onnx plus the encoders.json it was trained with. */
export interface DelayModel {
  encoders: Encoders;
  /** P(arrival delay >= 15 min) for each encoded row. */
  predict(rows: readonly Float32Array[]): Promise<number[]>;
  /** Releases the native onnxruntime session. */
  close(): Promise<void>;
}

/** Loads model.onnx once (onnxruntime-node, CPU); call at startup. */
export async function loadModel(artifactsDir = DEFAULT_ARTIFACTS_DIR): Promise<DelayModel> {
  const encoders = await loadEncoders(join(artifactsDir, 'encoders.json'));
  const session = await InferenceSession.create(join(artifactsDir, 'model.onnx'));
  if (!session.inputNames.includes(encoders.onnx.input)) {
    throw new Error(`model.onnx has no input named ${encoders.onnx.input}`);
  }
  if (!session.outputNames.includes(PROBABILITIES_OUTPUT)) {
    throw new Error(`model.onnx has no ${PROBABILITIES_OUTPUT} output`);
  }
  const width = FEATURE_COLUMNS.length;
  const column = encoders.onnx.probabilityOutputColumn;

  return {
    encoders,
    async predict(rows) {
      if (rows.length === 0) return [];
      const input = new Float32Array(rows.length * width);
      rows.forEach((row, i) => {
        if (row.length !== width)
          throw new Error(`Encoded row has ${row.length} values, not ${width}`);
        input.set(row, i * width);
      });
      const outputs = await session.run({
        [encoders.onnx.input]: new Tensor('float32', input, [rows.length, width]),
      });
      const probabilities = outputs[PROBABILITIES_OUTPUT];
      if (!probabilities || !(probabilities.data instanceof Float32Array)) {
        throw new Error('model.onnx returned no float32 probabilities');
      }
      const [n, classes] = probabilities.dims;
      if (n !== rows.length || classes === undefined || column >= classes) {
        throw new Error(
          `model.onnx returned probabilities of shape [${probabilities.dims.join(', ')}] for ${rows.length} rows (column ${column})`,
        );
      }
      const data = probabilities.data;
      return rows.map((_, i) => {
        const p = data[i * classes + column];
        if (p === undefined || !Number.isFinite(p)) throw new Error(`Non-finite probability ${p}`);
        return p;
      });
    },
    close: () => session.release(),
  };
}
