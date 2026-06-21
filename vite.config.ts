import { resolve } from "node:path";
import { defineConfig } from "vite";

// Frontend lives in src/web; build to dist/web, which the Bun server serves
// from a single origin (keeps the same-origin security checks trivial).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
  server: {
    // Allow importing shared modules from outside src/web (e.g. ../shared).
    fs: { allow: [resolve(import.meta.dirname)] },
  },
});
