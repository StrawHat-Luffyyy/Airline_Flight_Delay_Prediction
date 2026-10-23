import { describe, expect, it } from 'vitest';
import {
  classifyAlreadyStored,
  type MessageSource,
  type StoredDelivery,
} from '../../src/stream/already-stored.js';

const at = (offset: string, partition = 1, topic = 'flights.raw'): MessageSource => ({
  topic,
  partition,
  offset,
});
const item = (key: string, source: MessageSource) => ({ key, source });
const stored = (entries: [string, StoredDelivery][]) => new Map(entries);

describe('classifyAlreadyStored', () => {
  it('counts nothing for flights stored for the first time', () => {
    expect(classifyAlreadyStored([item('a', at('10')), item('b', at('11'))], new Map())).toEqual({
      sameMessage: 0,
      otherMessage: 0,
      unknown: 0,
    });
  });

  it('calls the message that last wrote the flight, read again, a redelivery', () => {
    const map = stored([['a', { lastSource: at('10') }]]);
    expect(classifyAlreadyStored([item('a', at('10'))], map).sameMessage).toBe(1);
  });

  it('calls an earlier message of the same partition a redelivery too (a rewind re-reads it)', () => {
    // The consumer rewound past a flight that a later message (offset 50) has already rewritten.
    const map = stored([['a', { lastSource: at('50') }]]);
    expect(classifyAlreadyStored([item('a', at('10'))], map)).toEqual({
      sameMessage: 1,
      otherMessage: 0,
      unknown: 0,
    });
  });

  it('calls a later message for a stored flight a replay or duplicate', () => {
    const map = stored([['a', { lastSource: at('10') }]]);
    expect(classifyAlreadyStored([item('a', at('60010'))], map)).toEqual({
      sameMessage: 0,
      otherMessage: 1,
      unknown: 0,
    });
  });

  it('compares offsets as integers', () => {
    const map = stored([['a', { lastSource: at('9') }]]);
    expect(classifyAlreadyStored([item('a', at('10'))], map).otherMessage).toBe(1);
  });

  it('calls a message from another topic or partition a different message', () => {
    const map = stored([
      ['a', { lastSource: at('10', 1, 'reliability.raw') }],
      ['b', { lastSource: at('10', 2) }],
    ]);
    expect(classifyAlreadyStored([item('a', at('5')), item('b', at('5'))], map).otherMessage).toBe(
      2,
    );
  });

  it('calls a second message for the same flight in one batch a duplicate', () => {
    expect(classifyAlreadyStored([item('a', at('10')), item('a', at('11'))], new Map())).toEqual({
      sameMessage: 0,
      otherMessage: 1,
      unknown: 0,
    });
  });

  it('cannot tell flights stored before positions were recorded apart: unknown', () => {
    const map = stored([['a', { lastSource: null }]]);
    expect(classifyAlreadyStored([item('a', at('10'))], map)).toEqual({
      sameMessage: 0,
      otherMessage: 0,
      unknown: 1,
    });
  });

  it('accounts for every already-stored delivery exactly once', () => {
    const map = stored([
      ['a', { lastSource: at('10') }],
      ['b', { lastSource: at('10') }],
      ['c', { lastSource: null }],
    ]);
    const counts = classifyAlreadyStored(
      [
        item('a', at('10')),
        item('b', at('99')),
        item('c', at('12')),
        item('d', at('13')),
        item('d', at('14')),
      ],
      map,
    );
    // 5 events, 1 new flight (d's first message): 4 already stored or repeated.
    expect(counts.sameMessage + counts.otherMessage + counts.unknown).toBe(4);
  });
});
