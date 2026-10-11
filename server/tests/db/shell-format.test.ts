import { describe, expect, it } from 'vitest';
import { toShellSyntax } from '../../src/db/shell-format.js';

describe('toShellSyntax', () => {
  it('prints dates as ISODate("...") instead of quoted strings', () => {
    expect(toShellSyntax({ airline: 'AA', date: { $gte: new Date(Date.UTC(2015, 2, 1)) } })).toBe(
      '{"airline":"AA","date":{"$gte":ISODate("2015-03-01T00:00:00.000Z")}}',
    );
  });

  it('handles dates inside arrays and pretty-printed output', () => {
    expect(toShellSyntax([{ $match: { date: new Date(Date.UTC(2015, 11, 24)) } }], 2)).toBe(
      [
        '[',
        '  {',
        '    "$match": {',
        '      "date": ISODate("2015-12-24T00:00:00.000Z")',
        '    }',
        '  }',
        ']',
      ].join('\n'),
    );
  });

  it('leaves strings that merely look like dates untouched', () => {
    expect(toShellSyntax({ note: '2015-03-01T00:00:00.000Z' })).toBe(
      '{"note":"2015-03-01T00:00:00.000Z"}',
    );
  });
});
