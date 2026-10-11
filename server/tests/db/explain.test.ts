import { describe, expect, it } from 'vitest';
import { summarizeExplain } from '../../src/db/explain.js';

describe('summarizeExplain', () => {
  it('reads a classic find explain (FETCH over IXSCAN)', () => {
    const summary = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'PROJECTION_SIMPLE',
          inputStage: {
            stage: 'FETCH',
            inputStage: { stage: 'IXSCAN', indexName: 'airline_1_date_1' },
          },
        },
      },
      executionStats: {
        executionTimeMillis: 12,
        totalKeysExamined: 100,
        totalDocsExamined: 100,
        nReturned: 100,
      },
    });
    expect(summary).toEqual({
      stages: ['PROJECTION_SIMPLE', 'FETCH', 'IXSCAN'],
      indexes: ['airline_1_date_1'],
      executionTimeMillis: 12,
      totalKeysExamined: 100,
      totalDocsExamined: 100,
      nReturned: 100,
    });
  });

  it('reads an aggregate explain whose query runs under $cursor', () => {
    const summary = summarizeExplain({
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
            executionStats: {
              executionTimeMillis: 900,
              totalKeysExamined: 0,
              totalDocsExamined: 5_819_079,
              nReturned: 40,
            },
          },
        },
        { $group: {} },
      ],
    });
    expect(summary).toMatchObject({
      stages: ['COLLSCAN'],
      indexes: [],
      totalDocsExamined: 5_819_079,
    });
  });

  it('reads a slot-based (SBE) plan wrapped in queryPlan, including OR branches', () => {
    const summary = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'GROUP',
            inputStage: {
              stage: 'OR',
              inputStages: [
                { stage: 'IXSCAN', indexName: 'a_1' },
                { stage: 'IXSCAN', indexName: 'b_1' },
              ],
            },
          },
          slotBasedPlan: { stages: 'ignored' },
        },
      },
      executionStats: {
        executionTimeMillis: 3,
        totalKeysExamined: 10,
        totalDocsExamined: 0,
        nReturned: 1,
      },
    });
    expect(summary.stages).toEqual(['GROUP', 'OR', 'IXSCAN', 'IXSCAN']);
    expect(summary.indexes).toEqual(['a_1', 'b_1']);
  });

  it('throws on output without execution stats', () => {
    expect(() =>
      summarizeExplain({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }),
    ).toThrow(/executionStats/);
  });
});
