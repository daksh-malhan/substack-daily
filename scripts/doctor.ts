/**
 * `bun run doctor` — verify the toolchain this project depends on (PLAN.md MG0).
 * Fails loudly (non-zero exit) if `codex` is missing, since synthesis depends on it.
 */
async function version(cmd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return proc.exitCode === 0 ? out : null;
  } catch {
    return null;
  }
}

const bunVersion = Bun.version;
const codexVersion = await version("codex", ["--version"]);

console.log(`bun:   ${bunVersion}`);
console.log(`codex: ${codexVersion ?? "MISSING"}`);

if (codexVersion === null) {
  console.error(
    "\nERROR: `codex` CLI not found on PATH. Synthesis requires it.\n" +
      "Install the Codex CLI (>= 0.130) and authenticate, then re-run `bun run doctor`.",
  );
  process.exit(1);
}
