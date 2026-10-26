import { describe, expect, it } from 'vitest';
import { FlightsQuerySchema } from '@flight-delay/shared';

const issues = (input: Record<string, string>): string[] => {
  const result = FlightsQuerySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('FlightsQuerySchema (GET /api/flights query)', () => {
  it.each([
    [{ airline: 'AA' }],
    [{ origin: 'ATL' }],
    [{ route: 'LAX-SFO' }],
    [{ from: '2015-12-24', to: '2015-12-26' }],
    [{ dest: 'ORD', origin: 'JFK' }],
    [{ dest: 'SFO', route: 'LAX-SFO', airline: 'UA' }],
  ])('accepts an index-backed filter: %o', (input) => {
    expect(FlightsQuerySchema.safeParse(input).success).toBe(true);
  });

  it.each([
    [{}],
    [{ dest: 'ORD' }],
    [{ from: '2015-12-24' }],
    [{ to: '2015-12-26' }],
    [{ dest: 'ORD', from: '2015-12-24' }],
  ])('rejects a query with no index-backed filter: %o', (input) => {
    expect(issues(input)).toContain(
      'Provide airline, origin, route, or a from+to date range; dest alone would scan the whole collection.',
    );
  });

  it.each([
    [{ dest: 'ORD', airline: 'AA' }],
    [{ dest: 'ORD', from: '2015-12-01', to: '2015-12-31' }],
  ])('rejects dest unless origin or route is given: %o', (input) => {
    expect(issues(input)).toContain(
      'dest has no index of its own: combine it with origin (or use route).',
    );
  });

  it('defaults limit to 20 and caps it at 100', () => {
    expect(FlightsQuerySchema.parse({ airline: 'AA' }).limit).toBe(20);
    expect(FlightsQuerySchema.parse({ airline: 'AA', limit: '100' }).limit).toBe(100);
    expect(FlightsQuerySchema.safeParse({ airline: 'AA', limit: '101' }).success).toBe(false);
  });

  it('validates code formats and date order', () => {
    expect(FlightsQuerySchema.safeParse({ airline: 'american' }).success).toBe(false);
    expect(FlightsQuerySchema.safeParse({ origin: '12478' }).success).toBe(false);
    expect(FlightsQuerySchema.safeParse({ route: 'LAXSFO' }).success).toBe(false);
    expect(issues({ from: '2015-12-26', to: '2015-12-24' })).toContain(
      'from must be on or before to.',
    );
  });

  it('rejects dates that are not on the calendar', () => {
    expect(issues({ from: '2015-02-30', to: '2015-03-01' })).toContain(
      'from must be a calendar date (YYYY-MM-DD)',
    );
    expect(issues({ from: '2015-12-01', to: '2015-99-99' })).toContain(
      'to must be a calendar date (YYYY-MM-DD)',
    );
    expect(FlightsQuerySchema.safeParse({ from: '2016-02-29', to: '2016-02-29' }).success).toBe(
      true,
    );
  });
});
