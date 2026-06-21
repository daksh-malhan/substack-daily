# Codex CLI contract (pinned by `bun run probe:codex`)

> Auto-generated probe of the local Codex CLI so MG4 builds against a verified
> interface. Re-run `bun run probe:codex` if the CLI is upgraded.

## Observed environment
- bun: `1.3.14`
- codex: `codex-cli 0.140.0`

## Invocation (use verbatim in MG4)
```
codex exec -s read-only --skip-git-repo-check --json -o <tmpfile> "<prompt>"
```
- `-s read-only`: sandbox; Codex only reads + synthesizes the text it is handed.
- `--skip-git-repo-check`: REQUIRED — this project is not a git repo, and codex
  refuses to run outside a trusted/git dir without it.
- `--json`: emits newline-delimited event objects on stdout (e.g. `thread.started`).
- `-o <tmpfile>`: writes the agent's FINAL message to `<tmpfile>`.
- stdin is ignored (`stdin: "ignore"`) so codex never blocks reading stdin.

## Output extraction (the contract MG4 consumes)
1. Spawn the command above with a unique temp `-o` file.
2. On exit code 0, read the `-o` file — it contains the agent's final message.
3. Extract the JSON object from that file via `/\{[\s\S]*\}/` then `JSON.parse`.
4. Validate the parsed object with the MG4 `zod` schema; retry once on failure.
5. Capture stderr (bounded) for observability; clean up the temp file in `finally`.

## Probe result
- exit code: `0`
- JSON parsed from `-o` file: `true`
- parsed value: `{"ok":true,"probe":"substack-magazine"}`
- stdout `--json` event types seen: `thread.started`, `turn.started`, `item.completed`, `turn.completed`

## Raw final message (`-o` file)
```
{"ok": true, "probe": "substack-magazine"}
```
