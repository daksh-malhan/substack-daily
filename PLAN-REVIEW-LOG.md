# Plan Review Log: Substack Surprise Magazine
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

Resolved decisions (Act 1):
- Source: random real Substack publication; pool = seed (~40) + `refresh-pool` scrape of discover.
- Content: hybrid — Codex connective tissue + real excerpts with links (substring-enforced, no fabrication).
- Fetching: RSS `/feed` + best-effort `/archive`; paywall → flagged, link out.
- Images: post-harvest + Google Custom Search (image mode), Codex-chosen queries; downloaded locally for offline.
- Synthesis: local `codex exec -s read-only --json` — no Claude API, no key/billing. Local-only app.
- App: local Bun web app + "Surprise me"; vanilla TS + Vite; pretext for article body, CSS chrome.
- Aesthetic: content picks the vibe (Codex chooses 1 of ~4–6 CSS presets + accent).
- Persistence: auto-save every magazine to `./library/` (Obsidian vault) — md + local images + `[[theme]]`/`[[newsletter]]` links; delete to prune.
- Graph: themes + newsletter.
- Offline: "Library" mode in the same app (net + Codex disabled).

## Round 1 — Codex
thread_id: 019ede8b-f3ba-7553-b363-60439c082421 — VERDICT: REVISE. 18 findings:
1. Codex CLI contract unpinned (MG4 built on unverified interface).
2. Prompt injection via fetched post HTML (could force fake quotes / file leak / JSON drift).
3. Excerpt substring check undefined re: entity decode / whitespace / Unicode / smart quotes / raw-vs-text.
4. Feed fetch ignores custom domains, redirects, malformed feeds, blocks, relative URLs.
5. Concurrent POST /surprise races on last-pick state.
6. Vault writes non-atomic — crash leaves half-written magazine folders Library treats as valid.
7. FS paths from names/themes/slugs lack sanitization / traversal / collision / macOS case handling.
8. Delete action may delete arbitrary paths via manipulated slug/json.
9. Image downloads unvalidated (MIME, size, redirects, SVG/script, decompression bombs, SSRF).
10. "drop tiny/icon/dup" undefined — avatars/tracking pixels become art.
11. Codex-returned sourceUrl/title → provenance drift (invented/mismatched citations).
12. Markdown doesn't visibly separate AI connective tissue vs quoted excerpts.
13. Library "no network" may still load remote links/fonts/CSS/leftover image URLs.
14. "reflow within ~1 frame" unrealistic; needs debounced/ResizeObserver settle metric.
15. pretext integration too late (MG9) — highest UI risk deferred past schema lock.
16. No per-stage observability (timing, domain, fetch counts, retry cause, Codex stderr, reject reasons, saved path).
17. Live CSE smoke call in success criteria → flaky tests.
18. Not ignoring library/ risks committing large/copyrighted/personal content.

### Claude's response
Accepted all 18 (no rejections — all are material and consistent with the locked decisions). Revising PLAN.md: pin Codex contract + probe in MG0; HTML→inert-text + untrusted-delimiter prompt hardening + malicious fixture (MG3/MG4); canonical text-normalization pipeline shared by fetch + excerpt check (MG0/MG3/MG4); excerpts reference post id/index, server attaches canonical URL/title (MG4); domain canonicalization/redirects/timeouts (MG3); pool-state atomicity + in-flight /surprise guard (MG2/MG7); atomic temp-folder+rename vault writes with manifest (MG6); slug sanitization + path containment for write & delete (MG6/MG10); image fetch hardening — MIME/size/time caps, reject SVG/HTML, hashed filenames, SSRF guard, avatar/icon/dim dedupe (MG5); visible AI-vs-quote labeling in md (MG6); Library network guard asserting local relative assets (MG10); reflow metric → no overlap after debounced settle 100–250ms (MG9); thin pretext spike in MG1; per-stage structured logs + debug id (MG7); automated tests fixture-only, live CSE behind manual script (MG5); gitignore library/ with .gitkeep + sample fixture (MG0).

## Round 2 — Codex
Prior 18 confirmed addressed. VERDICT: REVISE. 7 new findings:
R2-1. No Codex prompt-size/token budget — ~20 posts + archive can exceed limits / flake.
R2-2. MG5 claims hash+dimension dedupe but says it doesn't fetch bytes (contradiction; hashing needs bytes).
R2-3. No safe serving of library/ assets — static route could become arbitrary local file read.
R2-4. Obsidian `[[newsletter: …]]` links use colons/raw names — poor portable filenames, slug conflicts.
R2-5. Codex child process has no enforceable timeout/kill/cleanup.
R2-6. "local-only" wording misleading — codex exec is local invocation, not local inference; source text may leave the machine.
R2-7. refresh-pool can race pool/last-pick state vs the running server (in-process mutex insufficient).

### Claude's response
Accepted all 7. PLAN.md updated: deterministic content budget (MAX_POSTS / MAX_CHARS_PER_POST / archive sampling) + oversized-fixture truncation test (MG4); split image validation — MG5 metadata/URL-pattern only, byte-based hash+dimension dedupe moved to MG6 downloader; validated `GET /library-assets/:entryId/*` route via resolveInVault denying dotfiles/.tmp/incomplete/traversal + test (MG10); Obsidian links now `[[themes/<slug>|Name]]` / `[[newsletters/<slug>|Name]]` aliases, slug filenames (MG6); hard codex child-process timeout+kill+stdout/stderr caps+tmp cleanup + timeout-fixture test (MG4); explicit privacy-boundary statement in decisions + Risks (invocation ≠ inference; source may leave machine); refresh-pool now uses same file-lock/atomic-write discipline as last-pick (MG2).

## Round 3 — Codex
All 7 round-2 findings confirmed addressed. VERDICT: REVISE. 1 new finding:
R3-1. Local server exposes mutating routes (/surprise, delete) + asset route with no localhost-bind / cross-origin / CSRF protection — a malicious webpage could hit localhost.

### Claude's response
Accepted. PLAN.md MG1 updated: bind 127.0.0.1 only; middleware rejects non-local Host/Origin; mutations require same-origin JSON; applies to /library-assets; test hostile Origin/Host against /surprise, delete, /library-assets; assert socket not on non-loopback interface.

## Round 4 — Codex
R3-1 confirmed addressed (loopback-only bind, Host/Origin rejection, same-origin mutations, /library-assets coverage, hostile-request + non-loopback tests). No new material blocker.
VERDICT: APPROVED — converged after 4 rounds.
