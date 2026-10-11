import { describe, expect, it } from 'vitest';
import {
  ReferenceIndex,
  VoteTally,
  decideMappings,
  scheduleKey,
  type MappingThresholds,
} from '../../src/ingest/airport-ids.js';

const thresholds: MappingThresholds = { minVotes: 20, minTopShare: 0.99 };

function tallyWith(entries: [id: string, iata: string, origin: number, dest: number][]): VoteTally {
  const tally = new VoteTally();
  for (const [id, iata, origin, dest] of entries) {
    for (let i = 0; i < origin; i += 1) tally.addOrigin(id, iata);
    for (let i = 0; i < dest; i += 1) tally.addDest(id, iata);
  }
  return tally;
}

describe('scheduleKey', () => {
  it('identifies a scheduled service by airline, flight number and both times', () => {
    const key = scheduleKey({ airline: 'AA', flightNumber: 98, schedDepMin: 5, schedArrMin: 270 });
    expect(key).toBe('AA|98|5|270');
    expect(key).not.toBe(
      scheduleKey({ airline: 'AA', flightNumber: 98, schedDepMin: 5, schedArrMin: 271 }),
    );
  });
});

describe('ReferenceIndex', () => {
  it('keeps keys that always map to one origin/dest pair', () => {
    const index = new ReferenceIndex();
    index.add('AA|1|5|270', 'JFK', 'LAX');
    index.add('AA|1|5|270', 'JFK', 'LAX');
    expect(index.get('AA|1|5|270')).toEqual({ origin: 'JFK', dest: 'LAX' });
    expect(index.stats()).toEqual({ rows: 2, keys: 1, ambiguousKeys: 0 });
  });

  it('drops keys seen with more than one origin/dest pair', () => {
    const index = new ReferenceIndex();
    index.add('AA|1|5|270', 'JFK', 'LAX');
    index.add('AA|1|5|270', 'JFK', 'SFO');
    index.add('AA|1|5|270', 'JFK', 'LAX');
    expect(index.get('AA|1|5|270')).toBeUndefined();
    expect(index.stats()).toEqual({ rows: 3, keys: 1, ambiguousKeys: 1 });
  });
});

describe('decideMappings', () => {
  it('maps an id whose votes are >= 20 and >= 99% for one airport', () => {
    const [decision] = decideMappings(tallyWith([['10397', 'ATL', 15, 15]]), thresholds);
    expect(decision).toMatchObject({
      id: '10397',
      iata: 'ATL',
      accepted: true,
      votes: 30,
      topVotes: 30,
      topShare: 1,
      originVotes: 15,
      destVotes: 15,
    });
  });

  it('does NOT map an ambiguous id even with many votes', () => {
    const [decision] = decideMappings(
      tallyWith([
        ['11111', 'DFW', 60, 0],
        ['11111', 'DAL', 40, 0],
      ]),
      thresholds,
    );
    expect(decision).toMatchObject({
      id: '11111',
      iata: 'DFW',
      accepted: false,
      reason: 'low_top_share',
      votes: 100,
      topShare: 0.6,
      candidates: { DFW: 60, DAL: 40 },
    });
  });

  it('does NOT map at 98.9% top share, but does at exactly 99%', () => {
    const below = decideMappings(
      tallyWith([
        ['1', 'AAA', 989, 0],
        ['1', 'BBB', 11, 0],
      ]),
      thresholds,
    );
    const exact = decideMappings(
      tallyWith([
        ['1', 'AAA', 990, 0],
        ['1', 'BBB', 10, 0],
      ]),
      thresholds,
    );
    expect(below[0]?.accepted).toBe(false);
    expect(exact[0]?.accepted).toBe(true);
  });

  it('does NOT map an id with fewer than 20 votes', () => {
    const [decision] = decideMappings(tallyWith([['12345', 'BOS', 10, 9]]), thresholds);
    expect(decision).toMatchObject({ accepted: false, reason: 'too_few_votes', votes: 19 });
  });

  it('reports ids that had rows but no matching schedule as no_votes', () => {
    const tally = new VoteTally();
    tally.seen('99999');
    expect(decideMappings(tally, thresholds)[0]).toMatchObject({
      id: '99999',
      iata: null,
      accepted: false,
      reason: 'no_votes',
      votes: 0,
    });
  });

  it('rejects every id that would claim the same airport as another id', () => {
    const decisions = decideMappings(
      tallyWith([
        ['10001', 'ORD', 30, 0],
        ['10002', 'ORD', 0, 30],
        ['10003', 'LAX', 30, 0],
      ]),
      thresholds,
    );
    expect(decisions.map((d) => [d.id, d.accepted, d.reason])).toEqual([
      ['10001', false, 'iata_claimed_by_multiple_ids'],
      ['10002', false, 'iata_claimed_by_multiple_ids'],
      ['10003', true, undefined],
    ]);
  });
});
