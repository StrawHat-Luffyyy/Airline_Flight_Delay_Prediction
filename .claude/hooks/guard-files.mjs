// PreToolUse (Write|Edit|MultiEdit): protect data/secrets, enforce project rules on new code, flag leakage-prone edits.
import { ask, block, projectRoot, readInput, rel } from './lib.mjs';

const input = readInput();
const ti = input.tool_input ?? {};
const root = projectRoot(input);
const file = ti.file_path ?? ti.path ?? '';
if (!file) process.exit(0);
const p = rel(root, file);

const chunks = [
  ti.content,
  ti.new_string,
  ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : []),
].filter((x) => typeof x === 'string');
const content = chunks.join('\n');

// 1. Never write to raw data, .env, .git, node_modules
if (/^data\/raw\//.test(p)) block(`Blocked: ${p} is raw source data. Treat data/raw as read-only.`);
if (/(^|\/)\.env$/.test(p)) block('Blocked: do not edit .env. Change .env.example and tell the user what to set.');
if (/^\.git\//.test(p) || /(^|\/)node_modules\//.test(p)) block(`Blocked: ${p} is not editable.`);

// 2. Source-of-truth files: confirm with the user
if (/^(PROJECT_OVERVIEW\.md|CLAUDE\.md|\.claude\/(settings\.json|hooks\/|agents\/|skills\/))/.test(p)) {
  ask(`${p} is a project source-of-truth/config file. Record design changes in docs/DECISIONS.md unless you intend to change the spec.`);
}

// 3. Backend/shared code rules
if (/^(server|shared)\/.*\.(ts|tsx|mts)$/.test(p)) {
  if (/from\s+['"]mongoose['"]|require\(\s*['"]mongoose['"]\s*\)/.test(content)) {
    block('Blocked: Mongoose is not allowed. Use the official `mongodb` driver (PROJECT_OVERVIEW.md section 2).');
  }
  if (/(:\s*any\b|\bas\s+any\b|<any>|Array<any>|any\[\])/.test(content)) {
    block('Blocked: `any` is not allowed in server/shared code. Use `unknown` plus a zod schema, or a precise type.');
  }
}

// 4. Frontend: no Gemini / client-side API keys
if (/^(web|src)\//.test(p)) {
  if (/@google\/genai|GoogleGenAI|GEMINI_API_KEY|process\.env\.API_KEY|generativelanguage\.googleapis\.com/.test(content)) {
    block('Blocked: the frontend must not use Gemini / @google/genai or any API key. Replace it with data from the Express API (see docs/FRONTEND_AUDIT.md).');
  }
}

// 5. ML leakage firewall: confirm when feature code touches post-departure fields
if (/^(ml\/train\.py|server\/src\/(features|ml)\/)/.test(p)) {
  const leaky = content.match(
    /\b(depDelay|dep_delay|taxiOut|taxi_out|taxiIn|taxi_in|airTime|air_time|elapsedTime|elapsed_time|DEPARTURE_DELAY|DEPARTURE_TIME|TAXI_OUT|TAXI_IN|AIR_TIME|ELAPSED_TIME|WHEELS_ON|WHEELS_OFF|AIR_SYSTEM_DELAY|SECURITY_DELAY|AIRLINE_DELAY|LATE_AIRCRAFT_DELAY|WEATHER_DELAY)\b/,
  );
  if (leaky) {
    ask(`This edit to ${p} mentions "${leaky[0]}", a post-departure field that must never be a model feature (PROJECT_OVERVIEW.md section 7). Approve only if it is being excluded, not used.`);
  }
}

process.exit(0);
