/**
 * `npm run stream:score-missing`: scores stream_flights documents stored without a score (those
 * consumed before live scoring existed). Same scorer, same model as the consumer and /api/predict.
 * `--retry-refused` also re-scores UNKNOWN_ROUTE, UNKNOWN_CODE and SCORING_FAILED flights, for
 * example after `npm run build:stats` added a route.
 */
import { parseArgs } from 'node:util';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { logServedLookup } from '../ml/lookup-check.js';
import { createPredictor } from './predictor.js';
import { scoreMissing } from './score-missing.js';
import { streamFlights } from './store.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'retry-refused': { type: 'boolean', default: false } },
  });
  await connectToMongo();
  const { predict, model } = await createPredictor(getDb());
  await logServedLookup(getDb(), model.encoders.modelVersion, logger);
  const started = Date.now();
  let nextLogAt = 50_000;
  try {
    const summary = await scoreMissing(streamFlights(getDb()), predict, {
      retryRefused: values['retry-refused'],
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
