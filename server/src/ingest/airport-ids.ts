/**
 * Offline resolution of numeric BTS airport ids to IATA codes (pure logic, no I/O).
 *
 * Method: a scheduled service (airline, flight number, scheduled departure and arrival minute)
 * usually flies the same route month to month. Reference months with IATA codes give
 * key -> (origin, dest); a row with numeric ids and the same key then "votes" that its
 * origin id is that origin and its dest id is that dest.
 */

export interface ScheduledService {
  airline: string;
  flightNumber: number;
  schedDepMin: number;
  schedArrMin: number;
}

export interface MappingThresholds {
  /** Minimum total votes (origin + dest roles) for an id. */
  minVotes: number;
  /** Minimum share of votes for the winning IATA code, 0-1. */
  minTopShare: number;
}

export const DEFAULT_THRESHOLDS: MappingThresholds = { minVotes: 20, minTopShare: 0.99 };

export function scheduleKey(service: ScheduledService): string {
  return `${service.airline}|${service.flightNumber}|${service.schedDepMin}|${service.schedArrMin}`;
}

interface RoutePair {
  origin: string;
  dest: string;
}

const AMBIGUOUS = Symbol('ambiguous');

/** key -> the one (origin, dest) pair it was always seen with; keys seen with two pairs are dropped. */
export class ReferenceIndex {
  private readonly routes = new Map<string, RoutePair | typeof AMBIGUOUS>();
  private rows = 0;

  add(key: string, origin: string, dest: string): void {
    this.rows += 1;
    const existing = this.routes.get(key);
    if (existing === undefined) this.routes.set(key, { origin, dest });
    else if (existing !== AMBIGUOUS && (existing.origin !== origin || existing.dest !== dest)) {
      this.routes.set(key, AMBIGUOUS);
    }
  }

  get(key: string): RoutePair | undefined {
    const route = this.routes.get(key);
    return route === undefined || route === AMBIGUOUS ? undefined : route;
  }

  stats(): { rows: number; keys: number; ambiguousKeys: number } {
    let ambiguousKeys = 0;
    for (const route of this.routes.values()) if (route === AMBIGUOUS) ambiguousKeys += 1;
    return { rows: this.rows, keys: this.routes.size, ambiguousKeys };
  }
}

interface IdVotes {
  origin: Map<string, number>;
  dest: Map<string, number>;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Votes per numeric id -> IATA candidate, kept separately for the origin and dest roles. */
export class VoteTally {
  private readonly ids = new Map<string, IdVotes>();

  /** Registers an id that occurs in the data, even if no row for it finds a match. */
  seen(id: string): void {
    if (!this.ids.has(id)) this.ids.set(id, { origin: new Map(), dest: new Map() });
  }

  addOrigin(id: string, iata: string): void {
    this.seen(id);
    increment(this.votesFor(id).origin, iata);
  }

  addDest(id: string, iata: string): void {
    this.seen(id);
    increment(this.votesFor(id).dest, iata);
  }

  entries(): [string, IdVotes][] {
    return [...this.ids.entries()];
  }

  private votesFor(id: string): IdVotes {
    const votes = this.ids.get(id);
    if (!votes) throw new Error(`id ${id} not registered`);
    return votes;
  }
}

export type MappingRejectReason =
  'no_votes' | 'too_few_votes' | 'low_top_share' | 'iata_claimed_by_multiple_ids';

export interface AirportIdDecision {
  id: string;
  /** Winning IATA candidate, or null when there were no votes. */
  iata: string | null;
  accepted: boolean;
  reason?: MappingRejectReason;
  votes: number;
  topVotes: number;
  topShare: number;
  originVotes: number;
  destVotes: number;
  /** Every candidate and its combined vote count. */
  candidates: Record<string, number>;
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

function decide(id: string, votes: IdVotes, thresholds: MappingThresholds): AirportIdDecision {
  const combined = new Map<string, number>();
  for (const role of [votes.origin, votes.dest]) {
    for (const [iata, count] of role) combined.set(iata, (combined.get(iata) ?? 0) + count);
  }
  const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sum(combined);
  const [top] = ranked;
  const topVotes = top?.[1] ?? 0;
  const topShare = total === 0 ? 0 : topVotes / total;

  let reason: MappingRejectReason | undefined;
  if (total === 0) reason = 'no_votes';
  else if (total < thresholds.minVotes) reason = 'too_few_votes';
  else if (topShare < thresholds.minTopShare) reason = 'low_top_share';

  return {
    id,
    iata: top?.[0] ?? null,
    accepted: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    votes: total,
    topVotes,
    topShare,
    originVotes: sum(votes.origin),
    destVotes: sum(votes.dest),
    candidates: Object.fromEntries(ranked),
  };
}

/** One decision per id, sorted by id. Two accepted ids claiming one airport are both rejected. */
export function decideMappings(
  tally: VoteTally,
  thresholds: MappingThresholds,
): AirportIdDecision[] {
  const decisions = tally
    .entries()
    .map(([id, votes]) => decide(id, votes, thresholds))
    .sort((a, b) => a.id.localeCompare(b.id));

  const claims = new Map<string, number>();
  for (const d of decisions) if (d.accepted && d.iata) increment(claims, d.iata);

  return decisions.map((d) =>
    d.accepted && d.iata && (claims.get(d.iata) ?? 0) > 1
      ? { ...d, accepted: false, reason: 'iata_claimed_by_multiple_ids' }
      : d,
  );
}
