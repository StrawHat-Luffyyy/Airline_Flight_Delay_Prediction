import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { loadLookupFingerprint } from '../features/lookup.js';
import { MODEL_RUNS, type ModelRunDoc } from './register.js';

/**
 * Whether the served model's feature rates still come from the delay_lookup it was registered
 * against. A mismatch means delay_lookup was rebuilt from different flights (for example after a
 * re-ingest), so /predict would feed the model rates it was not trained with.
 */
export type LookupVerdict = 'match' | 'mismatch' | 'unpinned' | 'unregistered';

export function lookupVerdict(
  run: { registered: boolean; pinned: string | undefined },
  current: string,
): LookupVerdict {
  if (!run.registered) return 'unregistered';
  if (run.pinned === undefined) return 'unpinned';
  return run.pinned === current ? 'match' : 'mismatch';
}

export async function checkServedLookup(
  db: Db,
  modelVersion: string,
): Promise<{ verdict: LookupVerdict; current: string; pinned: string | undefined }> {
  const run = await db
    .collection<ModelRunDoc>(MODEL_RUNS)
    .findOne({ modelVersion }, { projection: { lookupFingerprint: 1 } });
  const current = await loadLookupFingerprint(db);
  const pinned = run?.lookupFingerprint;
  return { verdict: lookupVerdict({ registered: run !== null, pinned }, current), current, pinned };
}

/**
 * Which fingerprint `ml:register` pins: the one the latest training export recorded, because the
 * model learned from those rates. The current lookup is only a fallback for an export made before
 * fingerprints existed. `problem` says when the pin is not a clean match.
 */
export function chooseLookupPin({
  exported,
  current,
}: {
  exported: string | undefined;
  current: string;
}): { pin: string; problem: 'changed-since-export' | 'export-unpinned' | null } {
  if (exported === undefined) return { pin: current, problem: 'export-unpinned' };
  return { pin: exported, problem: exported === current ? null : 'changed-since-export' };
}

/**
 * Logs whether the rates a scorer is about to use match the served model's registration. Used by
 * the API at startup and by the stream CLIs that score (consume, score-missing). It only reports;
 * a failed check is a warning, never fatal.
 */
export async function logServedLookup(db: Db, modelVersion: string, logger: Logger): Promise<void> {
  try {
    const { verdict, current, pinned } = await checkServedLookup(db, modelVersion);
    const context = { modelVersion, lookupFingerprint: current, registeredFingerprint: pinned };
    if (verdict === 'match') logger.info(context, 'delay_lookup matches the served model');
    else if (verdict === 'mismatch')
      logger.error(
        context,
        'delay_lookup differs from the one the served model was trained on; predictions use rates the model never saw. Rebuild or retrain, then run npm run ml:register',
      );
    else
      logger.warn(
        context,
        verdict === 'unpinned'
          ? 'The served model was registered without a delay_lookup fingerprint; run npm run ml:register to pin it'
          : 'The served model is not registered in model_runs; run npm run ml:register',
      );
  } catch (error) {
    logger.warn(
      { err: error, modelVersion },
      'Could not compare delay_lookup with the served model',
    );
  }
}
