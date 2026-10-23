# Prettier baseline: nine web files left unformatted

Recorded 2026-10-23. These nine files under `web/src` differ from Prettier's output. They were left as they are on purpose: reformatting them would be an unrelated change mixed into other work.

## They do not block validation

- `npm run format:check` (and the CI step of the same name) checks `server`, `shared`, `vitest.config.ts` and `eslint.config.js` only, not `web/src`. It passes.
- `npm run typecheck`, `npm run lint`, `npm test` and the web build pass with these files as they are.

## The files

"Lines" counts the changed lines in a diff between the file and Prettier's output. "Last commit" is the last commit that touched the file.

| File                                      | Lines | Last commit            |
| ----------------------------------------- | ----- | ---------------------- |
| `web/src/components/globe/GlobeScene.tsx` | 84    | `5af46f7` (2026-10-18) |
| `web/src/components/globe/geo.test.ts`    | 1     | `5af46f7` (2026-10-18) |
| `web/src/components/globe/geo.ts`         | 1     | `5af46f7` (2026-10-18) |
| `web/src/components/globe/store.ts`       | 7     | `79c16b1` (2026-10-18) |
| `web/src/components/landing/Chapters.tsx` | 5     | `5af46f7` (2026-10-18) |
| `web/src/components/landing/Landing.tsx`  | 14    | `79c16b1` (2026-10-18) |
| `web/src/index.css`                       | 3     | `cfcc44b` (2026-10-22) |
| `web/src/lib/predictForm.test.ts`         | 5     | `1a28946` (2026-10-17) |
| `web/src/pages/Predict.tsx`               | 18    | `cfcc44b` (2026-10-22) |

## How to see or clear them

To list the files:

```bash
npx prettier --list-different web/src
```

To fix them, run `npx prettier --write` on exactly these files in a commit of their own that contains no other change. Then consider adding `web/src` to `format` and `format:check`, so CI keeps the web code formatted too.

One caveat: the Claude Code edit hook (`.claude/hooks/format-check.mjs`) runs Prettier on any file it edits. Editing one of these files therefore also reformats it, so its formatting change will show up in that commit's diff.
