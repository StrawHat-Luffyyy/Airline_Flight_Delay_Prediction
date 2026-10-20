import {
  flightKey,
  type FlightEvent,
  type FlightOutcome,
  type PredictRequest,
  type PredictResponse,
} from '@flight-delay/shared';
import { MongoError } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/middleware/error.js';
import {
  scoreEvents,
  scoreRequest,
  toScoringRequest,
  type Predictor,
} from '../../src/stream/score.js';

const PRE = {
  date: '2015-12-21',
  airline: 'AA',
  flightNumber: 1234,
  origin: 'ORD',
  dest: 'LAX',
  schedDepMin: 1050,
  schedDepHour: 17,
};
function event(outcome: Partial<FlightOutcome> = {}, pre: Partial<typeof PRE> = {}): FlightEvent {
  const p = { ...PRE, ...pre };
  return {
    v: 1,
    key: flightKey(p),
    runId: 'run-1',
    producedAt: 1,
    pre: p,
    outcome: {
      depDelay: 40,
      arrDelay: 55,
      isDelayed: true,
      cancelled: false,
      diverted: false,
      ...outcome,
    },
  };
}

const OUTCOME_FIELDS = [
  'depDelay',
  'arrDelay',
  'isDelayed',
  'cancelled',
  'diverted',
  'taxiOut',
  'taxiIn',
  'airTime',
  'elapsedTime',
  'causes',
];

function response(probability: number): PredictResponse {
  return {
    probability,
    label: probability >= 0.2 ? 'delayed' : 'on-time',
    threshold: 0.2,
    modelVersion: 'test-model',
    derived: { dayOfWeek: 1, isHolidayWeek: true, distance: 1744, scheduledTime: 275 },
    topFactors: [],
  };
}

/** A predictor that records exactly what it was given. */
function spyPredictor(probability = 0.31) {
  const seen: Record<string, unknown>[] = [];
  const predict: Predictor = async (request) => {
    seen.push({ ...request });
    return response(probability);
  };
  return { predict, seen };
}

describe('toScoringRequest', () => {
  it('maps only the five request fields of /api/predict from the pre-departure part', () => {
    const request = toScoringRequest(event().pre);
    expect(request).toEqual({
      date: '2015-12-21',
      airline: 'AA',
      origin: 'ORD',
      dest: 'LAX',
      schedDepHour: 17,
    });
    expect(Object.keys(request).sort()).toEqual(
      ['airline', 'date', 'dest', 'origin', 'schedDepHour'].sort(),
    );
  });
});

describe('the scorer cannot receive outcome fields', () => {
  it('is a compile-time error to pass anything but a ScoringRequest', async () => {
    const { predict } = spyPredictor();
    const withOutcome = { ...toScoringRequest(event().pre), ...event().outcome };
    const plain: PredictRequest = {
      date: '2015-12-21',
      airline: 'AA',
      origin: 'ORD',
      dest: 'LAX',
      schedDepHour: 17,
    };
    // @ts-expect-error: a whole event (with its outcome) is not a ScoringRequest
    await expect(scoreRequest(event(), predict)).rejects.toThrow();
    // @ts-expect-error: a request object built by hand is not a ScoringRequest either
    await scoreRequest(plain, predict).catch(() => undefined);
    // The spread copy is still branded (it carries the brand), so the runtime check is what
    // stops it: the strict request schema rejects every extra key.
    await expect(scoreRequest(withOutcome, predict)).rejects.toThrow(/unrecognized|Unrecognized/);
  });

  it('rejects at run time any request carrying an outcome field', async () => {
    const { predict, seen } = spyPredictor();
    for (const field of OUTCOME_FIELDS) {
      const leaked = { ...toScoringRequest(event().pre), [field]: 1 };
      await expect(scoreRequest(leaked, predict)).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it('hands the predictor exactly the five pre-departure keys when scoring whole events', async () => {
    const { predict, seen } = spyPredictor();
    await scoreEvents(
      [event(), event({}, { flightNumber: 2, origin: 'LAX', dest: 'ORD' })],
      predict,
    );
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(Object.keys(request).sort()).toEqual(
        ['airline', 'date', 'dest', 'origin', 'schedDepHour'].sort(),
      );
      for (const field of OUTCOME_FIELDS) expect(request).not.toHaveProperty(field);
    }
  });

  it('gives the same prediction whatever the outcome was', async () => {
    const { predict, seen } = spyPredictor();
    const [late] = await scoreEvents([event({ arrDelay: 180, isDelayed: true })], predict);
    const [early] = await scoreEvents(
      [event({ arrDelay: -20, depDelay: -5, isDelayed: false })],
      predict,
    );
    expect(seen[0]).toEqual(seen[1]);
    expect(late?.prediction).toEqual(early?.prediction);
  });
});

describe('scoreEvents', () => {
  it('stores probability, label, threshold and model version, then compares with the outcome', async () => {
    const { predict } = spyPredictor(0.31);
    const [delayedRight, onTimeWrong, cancelled] = await scoreEvents(
      [
        event({ isDelayed: true }),
        event({ isDelayed: false, arrDelay: 2 }, { flightNumber: 2 }),
        event({ isDelayed: null, cancelled: true, arrDelay: null }, { flightNumber: 3 }),
      ],
      predict,
    );
    expect(delayedRight).toEqual({
      key: event().key,
      prediction: {
        probability: 0.31,
        label: 'delayed',
        threshold: 0.2,
        modelVersion: 'test-model',
      },
      scoreError: null,
      correct: true,
    });
    expect(onTimeWrong?.correct).toBe(false);
    // No arrival outcome (cancelled or diverted): scored, but not judged.
    expect(cancelled).toMatchObject({ correct: null, scoreError: null });
    expect(cancelled?.prediction).not.toBeNull();
  });

  it('records a predictable refusal (unknown route or code) instead of failing the batch', async () => {
    const predict: Predictor = async () => {
      throw new HttpError(422, 'UNKNOWN_ROUTE', 'No 2015 flights on ORD-XYZ');
    };
    const [result] = await scoreEvents([event()], predict);
    expect(result).toEqual({
      key: event().key,
      prediction: null,
      scoreError: 'UNKNOWN_ROUTE',
      correct: null,
    });
  });

  it('records an event the request schema refuses (e.g. a numeric BTS airport id)', async () => {
    const { predict, seen } = spyPredictor();
    const [result] = await scoreEvents([event({}, { origin: '10397' })], predict);
    expect(result).toMatchObject({ prediction: null, scoreError: 'INVALID_REQUEST' });
    expect(seen).toEqual([]);
  });

  it('rethrows a MongoDB failure, so the batch is redelivered', async () => {
    const predict: Predictor = async () => {
      throw new MongoError('connection refused');
    };
    await expect(scoreEvents([event()], predict)).rejects.toThrow(/connection refused/);
  });

  it('records any other failure on the flight instead of blocking the partition', async () => {
    const bug: Predictor = async () => {
      throw new Error('Model returned 1 scores for 6 rows');
    };
    expect((await scoreEvents([event()], bug))[0]).toMatchObject({
      prediction: null,
      scoreError: 'SCORING_FAILED',
    });
    const refused: Predictor = async () => {
      throw new HttpError(422, 'SOMETHING_NEW', 'refused');
    };
    expect((await scoreEvents([event()], refused))[0]).toMatchObject({
      scoreError: 'SOMETHING_NEW',
    });
  });

  it('scores each flight key once per call, even if it was delivered twice', async () => {
    const { predict, seen } = spyPredictor();
    const results = await scoreEvents([event(), event()], predict);
    expect(seen).toHaveLength(1);
    expect(results).toHaveLength(1);
  });
});
