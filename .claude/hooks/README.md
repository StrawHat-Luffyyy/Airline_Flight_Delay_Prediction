# Hooks

Plain Node scripts (no jq, no bash-only syntax), wired up in `.claude/settings.json`.

| Event                  | Script            | What it does                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart           | session-start.mjs | Injects git branch, recent commits, layout (web/server/shared), docs present, data/raw files, MongoDB container status                                                                                                                                                     |
| PreToolUse Bash        | guard-bash.mjs    | Blocks `docker compose down -v`, volume removal, manual mongosh drops, force push, `reset --hard`, `rm` of data/.git, installing mongoose, printing .env, `cat flights.csv`. On `git commit`: blocks data/.env/dist/csv/zip files and API keys / Mongo URIs with passwords |
| PreToolUse Write/Edit  | guard-files.mjs   | Blocks edits to data/raw, .env; asks before editing PROJECT_OVERVIEW.md, CLAUDE.md, .claude/\*; blocks mongoose and `any` in server/ and shared/; blocks Gemini / API keys in web/; asks when ML feature code mentions post-departure fields                               |
| PostToolUse Write/Edit | format-check.mjs  | Prettier (only if the repo has a prettier config), type errors in the edited file are fed back to Claude, reminders for untested pipelines and leakage-sensitive files                                                                                                     |
| Stop                   | stop-check.mjs    | If modified .ts/.tsx files have type errors, makes Claude fix them before finishing (once, no loops)                                                                                                                                                                       |

`settings.json` also denies Claude reading `.env`, `data/raw/**` and `data/export/**`.

Hooks are loaded at session start. Restart Claude Code after adding them, and check `/hooks`.
If a hook cannot find the script on your machine, change `"$CLAUDE_PROJECT_DIR/.claude/hooks/x.mjs"` to the relative `.claude/hooks/x.mjs`.
To disable one temporarily, remove its entry from settings.json.
