/** Placeholder that cannot occur in real query text; swapped for ISODate(...) after stringify. */
const MARKER = '__ISODATE__:';

/**
 * JSON for a query or pipeline, with Date values written the way mongosh prints them
 * (`ISODate("2015-03-01T00:00:00.000Z")`) so listings can be pasted into the shell.
 */
export function toShellSyntax(value: unknown, indent?: number): string {
  const json = JSON.stringify(
    value,
    function replacer(this: Record<string, unknown>, key: string, current: unknown) {
      // JSON.stringify calls Date.toJSON before the replacer, so check the holder's raw value.
      const raw = this[key];
      return raw instanceof Date ? `${MARKER}${raw.toISOString()}` : current;
    },
    indent,
  );
  return json.replace(new RegExp(`"${MARKER}([^"]+)"`, 'g'), 'ISODate("$1")');
}
