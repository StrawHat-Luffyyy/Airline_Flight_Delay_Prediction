/**
 * `npm run stream:score-missing`: scores stream_flights documents stored without a score (those
 * consumed before live scoring existed). Same scorer, same model as the consumer and /api/predict.
 */
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { createPredictor } from './predictor.js';
import { scoreMissing } from './score-missing.js';
import { streamFlights } from './store.js';

async function main(): Promise<void> {
  await connectToMongo();
  const { predict, model } = await createPredictor(getDb());
  const started = Date.now();
  let nextLogAt = 50_000;
  try {
    const summary = await scoreMissing(streamFlights(getDb()), predict, {
      onProgress: (progress) => {
        if (progress.scanned < nextLogAt) return;
        nextLogAt += 50_000;
        logger.info({ ...progress }, 'stream:score-missing progress');
      },
    });
    const seconds = (Date.now() - started) / 1000;
    logger.info(
      {
        ...summary,
        modelVersion: model.encoders.modelVersion,
        seconds: Math.round(seconds),
        perSecond: Math.round(summary.scanned / Math.max(seconds, 0.001)),
      },
      'stream:score-missing finished',
    );
  } finally {
    await model.close();
  }
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:score-missing failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
