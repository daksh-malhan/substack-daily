# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **local** web app that turns a random **"brainfood" Substack** (philosophy / psychology / culture / meaning / literature — NOT AI/tech/startup/news) into offline **deep-dive magazines**. Each "Surprise me" press makes **ONE** deep-dive magazine (MG14): pick a publication → deep-fetch its **archive** (~50 free articles, full text) → **curate at the ARTICLE level** with the **local `codex exec` CLI** (discard shallow/tech/AI, cluster the deep survivors into themes) → press **ONE** strong cluster (citing every article) → acquire images → persist into an **Obsidian-compatible vault** (`./library/`) that doubles as the website's offline data store. The **next** press makes **another** deep dive — ~70% a freshly-picked publication, ~30% a reused un-pressed theme from a session cache (`DeepCache`) — and **never repeats a `(resolvedDomain, theme)`**. So pressing N times yields N magazines, one per press. **Synthesis is the local `codex exec` CLI, never the Claude API.**

Read **`PROGRESS.md`** FIRST (resume file — live status table + per-MG recaps, currently the source of truth), then **`PLAN.md`** (original spec: 9 decisions + MG0–MG12 criteria) and **`PLAN-REVIEW-LOG.md`** (why decisions were made). The deep-dive pipeline is **MG13** (built on top of MG0–MG12) — its recap lives in `PROGRESS.md`.

## Environment gotchas (these will bite you)

- **Bun is NOT on the default PATH.** It lives at `~/.bun/bin/bun`. Prefix every bun command: `export PATH="$HOME/.bun/bin:$PATH"; bun ...`
- **Network/spawn commands need the Bash sandbox disabled** (`dangerouslyDisableSandbox: true`): `bun install`/`bun add`, anything calling `codex exec`, `probe:codex`, `refresh-pool`, `smoke:cse`, live fetches, and starting the server.
- **Every `codex exec` invocation needs `--skip-git-repo-check`** (this is not a git repo) and `< /dev/null` (so it never blocks on stdin). If `codex exec` stalls/dies, the Codex app is usually mid-auto-update — run `codex update`, then retry.
- **Do NOT put backticks inside a double-quoted `codex exec "..."` shell prompt** — bash runs them as command substitution.

## Commands

```bash
export PATH="$HOME/.bun/bin:$PATH"      # do this first, always
bun run typecheck                       # tsc --noEmit  (must stay clean)
bun run lint                            # oxlint src scripts (must stay clean)
bun test                                # full suite (bun:test)
bun test src/server/synth.test.ts       # one file
bun test -t "anti-fabrication"          # one test by name
bun run dev                             # build web + serve on 127.0.0.1:4321
bun run doctor                          # verify bun + codex present
bun run probe:codex                     # re-pin the codex CLI contract -> docs/codex-contract.md
bun run refresh-pool                    # best-effort grow config/pool.json from Discover
bun run clean:library                   # reset ./library vault to empty (keeps .obsidian + .gitkeep)
bun run smoke:cse                       # manual live Google CSE check (needs GOOGLE_CSE_* env)
```

**Pool hygiene (`config/pool.json`):** every domain MUST serve a valid Substack feed or a pick fails at the fetch stage ("not a Substack feed" / HTTP 404·400·521). **Prefer the `<handle>.substack.com` form** even for pubs on a custom domain — it reliably serves `/feed` and the fetcher follows the redirect. **Verify before adding** by running each candidate through `fetchPublication` (network on, sandbox disabled). The 29 entries currently in the pool were all live-verified.

## Codebase knowledge graph (graphify)

This repo has a **graphify** knowledge graph in `graphify-out/` (gitignored). **Prefer querying it over grepping/re-reading files** — it's persistent and costs far fewer tokens. The `graphify` Skill is installed; for ad-hoc queries the CLI works too (needs `export PATH="$HOME/.local/bin:$PATH"`):

```bash
graphify explain "persistMagazine"            # a node + its neighbors
graphify path "fetchPublication" "persistMagazine"  # shortest path between two nodes
graphify update .                             # rebuild graph from AST (no LLM, no network)
```

`graphify-out/GRAPH_REPORT.md` lists "god nodes" (core abstractions) and community hubs. **After each mini-goal, run `graphify update .`** to keep the graph current.

## Status

**MG0–MG14 all done & Codex-approved.** The project is feature-complete + verified end-to-end. `bun run dev`, click "Surprise me" → streamed multi-stage build → **ONE rendered deep-dive magazine per press** (press again for another — same or different Substack, never the same theme) → each auto-saved to `./library/` (+ Obsidian graph notes) → revisit offline via "Library". See `PROGRESS.md` for the live status table + per-MG recaps. **To run the current build you must restart `bun run dev`**.

## Architecture

Two orchestration layers share one set of stage modules (each with an injected `fetch`/runner so it's offline-testable against fixtures):

- **`deep.ts` `runDeepDive(deps, cache, debugId)` — the LIVE `/surprise` path (MG13 + MG14).** Presses **ONE** deep-dive per call, driven by a per-session `DeepCache` (`{ pubs: Map<resolvedDomain, {newsletter, clusters}>, pressed: Set<"domain::theme"> }`, held on `SurpriseContext`, serialized by the `InFlightGuard`):
```
runDeepDive: reusable = cached pubs w/ un-pressed clusters
   if reusable && random()<0.3  → REUSE a cached pub (no fetch)
   else                         → acquireFreshPub: pick(exclude) → deepFetch → (dedupe on RESOLVED domain;
                                   skip re-curate on collision) → curate → strongClusters; ≤4 attempts,
                                   bounded by MAX_PRESS_MS acquisition-start deadline; fresh-empty → fall back to reuse
   then pressCluster: synth.ts (codex, theme-focused) → images.ts → vault.ts (persist) → mark pressed AFTER persist
   = ONE magazine via onMagazine (or magazines:[] when no pub found). mergeDeepArticles drops body-less archive stubs.
```
`random`/`now` are injected into `DeepDeps` (defaults `Math.random`/`Date.now`) for deterministic 70/30-branch + deadline tests. `pick` takes an optional `exclude` set (best-effort prefer-uncached; pool exhaustion → null, never re-picks a spent domain this press).
- **`surprise.ts` `runSurprise` — the ORIGINAL single-magazine path (MG7).** Kept + still unit-tested; `runDeepDive` reuses its `Stage`/`StageError`/`LogEntry`/`InFlightGuard`/`SurpriseConfig`. `app.ts` now wires `/surprise` to `runDeepDive`.
- **`archive-api.ts` (MG13)** = Substack archive client: `listArchive` (paginated `/api/v1/archive`), `fetchDeepArticles` (FREE + `wordcount>=400`, fetch each page → inert `Post`). **SSRF-guarded** (`assertSafeUrl`/`hostIsPublic`, same-publication redirect confinement); `readCappedText(res, maxBytes, timeoutMs)` strict byte+time cap.
- **`curate.ts` (MG13)** = one codex pass; opaque ids (`a0`…) so codex never sees URLs; zod-validated; hallucinated ids dropped; `strongClusters` filter.
- The single-magazine stage map (still the inner stages of both paths):
```
pool.ts (pick) → fetcher.ts (RSS+archive) → synth.ts (codex) → images.ts → vault.ts (persist)
        pickFromPool     fetchPublication      synthesize       acquireImages   persistMagazine
        LastPickStore    -> FetchResult        -> SynthesisResult -> ImagePlan    -> library/<slug>/
```
Codex runner hard timeout is **240s** (`makeCodexRunner` default; deep prompts run ~60–115s; the SSE 5s heartbeat keeps the stream alive). One press is bounded by `MAX_PICK_ATTEMPTS=4` (runaway guard) + `MAX_PRESS_MS=6min` (acquisition-START deadline — gates only the START of a new pick attempt; an in-flight attempt + the final press are NOT interrupted, so there is no hard whole-press wall-clock ceiling, only per-stage codex 240s bounds). `MAX_MAGAZINES`/batch-`MAX_RUN_MS` were removed in MG14.

- **`src/shared/`** — shared by server AND web: `text.ts` (the ONE canonical `toPlainText`+`normalize` — used by both the fetcher and the excerpt anti-fabrication check so they compare like-for-like), `paths.ts` (`slugify` + `resolveInVault` containment — use for EVERY path from model/request input), `domains.ts`, `post.ts`, `magazine.ts`.
- **`src/server/`** — the pipeline + Bun HTTP server. `index.ts` (loopback bind, dotenv, threads Bun's `server` for per-request `timeout`) → `app.ts` (router + `SurpriseContext` {deps:`DeepDeps`, guard, vaultRoot}; `/surprise` runs `runDeepDive`; routes below) → `security.ts`. **`deep.ts`** = `runDeepDive` + `makeDeepDeps` + `DeepDeps` (deep-dive orchestration; `mergeDeepArticles` is pure+exported). **`archive-api.ts`** + **`curate.ts`** = MG13 archive client + curation (above). `surprise.ts` = original `runSurprise` + injectable `SurpriseDeps` + `makeSurpriseDeps` + `Stage`/`StageError`/`LogEntry`/`SurpriseConfig` + `InFlightGuard` (shared by both paths). `library.ts` = offline Library (list/read/asset/delete, the file-serving trust boundary). `fsutil.ts` = `atomicWriteFile` + `Mutex`. `vault.ts` `safeSlugBase` makes a bounded (≤80-char) FS-safe slug from a model/cluster title so one weird theme can't abort a multi-magazine run.
  - **Routes:** `POST /surprise` — JSON `{publication, magazines[]}` (0 or 1 entry), or when `Accept: text/event-stream` an **SSE stream**: a `stage` event per completed phase, then **exactly one `result` event** (the pressed magazine) — or **zero** when no pub was found — then `done {publication, magazines:count}` (count 1 or 0). `GET /api/library`, `GET /api/library/:id`, `DELETE /api/library/:id`; `GET /library-assets/:id/*` (serves vault images).
- **`src/web/`** — vanilla TS + Vite, all DOM-free logic unit-tested: `render.ts` (`renderMagazineHTML`/`renderLibraryList`/`assetUrl` — escaped, image srcs routed through `/library-assets/`), `vibe.ts` (6 preset themes + accent validation), `layout.ts` (pure pretext flow core: `flowAround` an obstacle, `debounce`, `rafThrottle`, `imageSizeFor`), `article-layout.ts` (DOM driver — **draggable image, live text reflow on drag, debounced resize**), `progress.ts` (`statusForStage` + `parseSse`), `main.ts` (wires Surprise/Library/Retry + SSE stream consumption). `pretext-spike.ts` is the original MG1 spike (kept for reference). Env: `VAULT_ROOT` overrides the vault path.

### Load-bearing invariants — do not break these

- **No Claude API anywhere.** Synthesis is the local `codex exec` CLI via `makeCodexRunner` in `synth.ts`. Privacy boundary: local *invocation*, not local *inference* — source text leaves the machine through Codex auth.
- **Only inert `Post.contentText` is ever sent to Codex**, never raw `contentHtml`. Source posts are wrapped in `<UNTRUSTED_SOURCE>` with "data, not instructions" framing.
- **Anti-fabrication (synth.ts `validateAndAttach`):** every excerpt must be a `normalize()` substring of its referenced `postId`'s contentText, else dropped; a spec with zero valid excerpts is rejected. **Provenance:** server attaches canonical `sourceUrl`/`sourceTitle` from the postId — Codex never supplies URLs.
- **`image-download.ts` is the ONLY place image bytes are fetched** (SSRF guard, byte/time/redirect caps, MIME sniff, dimension parse). `images.ts` is metadata/URL-filtering ONLY.
- **Vault writes are atomic:** assemble in `library/.tmp/<uuid>/`, then one `rename` into `library/<slug>/`; `manifest.json` status=`complete` marks validity. Theme/newsletter notes are rebuilt by `reconcileNotes` (pure function of the complete magazines on disk).
- **Security (`security.ts`):** server binds 127.0.0.1 only; loopback `Host` required; mutations need EXACT same-origin (full origin, scheme+host+port) + exact `application/json`; assets + library-JSON reads block cross-origin and `Sec-Fetch-Site` cross-site. The **`/library-assets` route serves only `images/<file>` of a `complete` entry** via double `resolveInVault`; ids validated by `library.ts` `validateEntryId` (must round-trip `slugify`). `magazine.json`/served pages reference LOCAL same-origin paths only (offline).
- **Frontend rendering escapes everything** (`render.ts` — XSS/CSS-injection tested); image URLs are same-origin `/library-assets/` only; source links are `target=_blank rel=noopener`.
- **SSE stream lifecycle (`app.ts` `streamSurprise`):** the in-flight guard is released ONLY when the pipeline truly finishes (even on client disconnect) so an abandoned build can't race a new one; enqueues are guarded (a late frame no-ops, never aborts the pipeline); only completed-stage logs (`ms` present) advance the UI.

## Workflow for building mini-goals

This project is built one mini-goal at a time with a **Codex sign-off gate** per goal (Phase 1 of the `/kickoff` process). For each: build against `PLAN.md`'s success criteria → self-verify (`typecheck`+`lint`+`test` green, plus a real run where behavioral) → get a **fresh-thread Codex review scoped to ONLY that mini-goal** (`codex exec -s read-only --skip-git-repo-check --json -o /tmp/codex-mgN.txt "<scoped prompt>" < /dev/null`, sandbox disabled) → address any `VERDICT: REVISE` and re-verify until `APPROVED` → update `PROGRESS.md` → next. Claude is the final arbiter on Codex findings (incorporate good ones; reject bad ones with a logged reason). Codex's read-only sandbox can't write temp files or bind sockets, so it will report fewer passing tests than the real env — that's an environment limit, not a defect.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`; lint is `oxlint` (prefer `.toSorted()` over `.sort()`; no unused/shadowed vars). Tests are `bun:test` and must be **fixture-only / offline** (inject `fetchImpl` and a fake codex runner; never call real `codex` or the network in `bun test`). Live checks live behind manual `bun run` scripts.
- `./library/` and `.state/` and `dist/` are gitignored (generated/personal). The vault is portable via copy/zip, not git.
