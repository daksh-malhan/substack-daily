/**
 * `bun run probe:codex` — pin the Codex CLI contract (PLAN.md MG0, addresses review #1).
 *
 * Runs a fixed, JSON-only `codex exec` invocation, observes how the result is
 * delivered, and writes `docs/codex-contract.md` documenting the EXACT command
 * and output-extraction method that MG4 must consume. Keeping this in a probe
 * means MG4 is built against a verified interface, not an assumed one.
 *
 * Note: this repo is not a git directory, so `--skip-git-repo-check` is
 * mandatory on every `codex exec` (a hard requirement carried forward to MG4).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT =
  "Output exactly one JSON object and nothing else: " +
  '{"ok": true, "probe": "substack-magazine"}';

const outFile = join(tmpdir(), `codex-probe-${Date.now()}.json`);
const ARGS = [
  "exec",
  "-s",
  "read-only",
  "--skip-git-repo-check",
  "--json",
  "-o",
  outFile,
  PROMPT,
];

console.log(`$ codex ${ARGS.map((a) => (a === PROMPT ? '"<prompt>"' : a)).join(" ")}`);

const proc = Bun.spawn(["codex", ...ARGS], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
await proc.exited;

if (proc.exitCode !== 0) {
  console.error(`codex exec failed (exit ${proc.exitCode}).`);
  console.error(stderr.trim().slice(-2000));
  process.exit(1);
}

let lastMessage = "";
try {
  lastMessage = (await readFile(outFile, "utf8")).trim();
} catch {
  console.error(`Expected output file was not written: ${outFile}`);
  process.exit(1);
}

// The -o file holds the agent's final message. Extract the JSON object from it.
const match = lastMessage.match(/\{[\s\S]*\}/);
let parsed: unknown = null;
let parseOk = false;
if (match) {
  try {
    parsed = JSON.parse(match[0]);
    parseOk = true;
  } catch {
    parseOk = false;
  }
}

// Sample a couple of jsonl event types from --json stdout for documentation.
const eventTypes = Array.from(
  new Set(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type ?? null;
        } catch {
          return null;
        }
      })
      .filter((t): t is string => t !== null),
  ),
).slice(0, 12);

const doc = `# Codex CLI contract (pinned by \`bun run probe:codex\`)

> Auto-generated probe of the local Codex CLI so MG4 builds against a verified
> interface. Re-run \`bun run probe:codex\` if the CLI is upgraded.

## Observed environment
- bun: \`${Bun.version}\`
- codex: \`${(await codexVersion()) ?? "unknown"}\`

## Invocation (use verbatim in MG4)
\`\`\`
codex exec -s read-only --skip-git-repo-check --json -o <tmpfile> "<prompt>"
\`\`\`
- \`-s read-only\`: sandbox; Codex only reads + synthesizes the text it is handed.
- \`--skip-git-repo-check\`: REQUIRED — this project is not a git repo, and codex
  refuses to run outside a trusted/git dir without it.
- \`--json\`: emits newline-delimited event objects on stdout (e.g. \`thread.started\`).
- \`-o <tmpfile>\`: writes the agent's FINAL message to \`<tmpfile>\`.
- stdin is ignored (\`stdin: "ignore"\`) so codex never blocks reading stdin.

## Output extraction (the contract MG4 consumes)
1. Spawn the command above with a unique temp \`-o\` file.
2. On exit code 0, read the \`-o\` file — it contains the agent's final message.
3. Extract the JSON object from that file via \`/\\{[\\s\\S]*\\}/\` then \`JSON.parse\`.
4. Validate the parsed object with the MG4 \`zod\` schema; retry once on failure.
5. Capture stderr (bounded) for observability; clean up the temp file in \`finally\`.

## Probe result
- exit code: \`${proc.exitCode}\`
- JSON parsed from \`-o\` file: \`${parseOk}\`
- parsed value: \`${parseOk ? JSON.stringify(parsed) : "<unparseable>"}\`
- stdout \`--json\` event types seen: ${eventTypes.length ? eventTypes.map((t) => `\`${t}\``).join(", ") : "_(none parsed)_"}

## Raw final message (\`-o\` file)
\`\`\`
${lastMessage.slice(0, 800)}
\`\`\`
`;

async function codexVersion(): Promise<string | null> {
  try {
    const p = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
    const v = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return p.exitCode === 0 ? v : null;
  } catch {
    return null;
  }
}

await mkdir("docs", { recursive: true });
await writeFile("docs/codex-contract.md", doc, "utf8");
console.log(`\nWrote docs/codex-contract.md (JSON parsed: ${parseOk}).`);
if (!parseOk) {
  console.error("WARNING: probe did not yield parseable JSON — inspect the contract doc.");
  process.exit(1);
}
