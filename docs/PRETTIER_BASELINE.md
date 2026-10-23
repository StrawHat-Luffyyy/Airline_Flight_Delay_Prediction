# Prettier baseline: resolved

Recorded 2026-10-23, resolved 2026-10-24.

Nine `web/src` files were once left unformatted on purpose, so that a reformat would not be mixed into unrelated work. By 2026-10-24 two of them had been reformatted with other changes. The remaining seven were formatted on their own (a format-only diff, with no behaviour change).

`npm run format:check`, and the CI step of the same name, now covers `web/src` as well as `server`, `shared`, `vitest.config.ts` and `eslint.config.js`. New web files are held to the same rule.
