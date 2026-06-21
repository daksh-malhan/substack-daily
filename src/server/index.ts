/**
 * Server entry (PLAN.md MG1 + MG7). Binds the router to LOOPBACK ONLY
 * (127.0.0.1). Binding to 127.0.0.1 is what makes the socket unreachable from
 * other hosts; the securityCheck middleware is defence-in-depth against DNS
 * rebinding / CSRF. Loads `.env` (dotenv) so GOOGLE_CSE_KEY/GOOGLE_CSE_ID reach
 * the image stage, then wires the real MG2–MG6 pipeline context once.
 */
import "dotenv/config";
import { createDefaultContext, handleRequest, type SurpriseContext } from "./app.ts";

/** Loopback-only bind address. Exported so tests can assert it. */
export const HOSTNAME = "127.0.0.1";

/**
 * Start the server bound to loopback. `port: 0` picks a free port (tests).
 * Bun calls `fetch(request, server)`, so we wrap to keep our own context in the
 * second arg (never the Bun Server object).
 */
export function startServer(
  port: number = Number(process.env.PORT ?? 4321),
  ctx: SurpriseContext = createDefaultContext(),
) {
  // Only the /surprise build needs a long idle window; handleSurprise raises it
  // per-request via server.timeout(req, …) (the synthesis stage is silent for
  // ~30–60s), so other routes keep Bun's short default. The SSE stream also
  // sends heartbeats (app.ts) as belt-and-suspenders.
  return Bun.serve({ hostname: HOSTNAME, port, fetch: (req, server) => handleRequest(req, ctx, server) });
}

// Only auto-start when run directly (`bun run src/server/index.ts`), not on import.
if (import.meta.main) {
  const server = startServer();
  console.log(
    `Substack Surprise Magazine — listening on http://${HOSTNAME}:${server.port}`,
  );
}
