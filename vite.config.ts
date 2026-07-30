/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port (matches devUrl in tauri.conf.json).
// 3630, not Tauri's default 1420: Windows winnat/Hyper-V reserves shifting port
// blocks and EACCES-blocks listening inside them. Those blocks keep crawling
// through the 1000-2300 region — they swallowed 1430, then 1630 (1579-1678 as
// of 2026-07-30). 3630 sits in the wide gap above them. Check with
// `netsh interface ipv4 show excludedportrange protocol=tcp` before moving it.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 3630,
    strictPort: true,
  },
  // Keep the test config here and nowhere else: a vitest.config.ts would be
  // loaded *instead of* this file, silently dropping the excludes below.
  test: {
    environment: "happy-dom",
    // mcp/ is its own package with its own vitest; .claude/ holds worktree copies.
    exclude: ["**/node_modules/**", "**/dist/**", "mcp/**", ".claude/**"],
  },
});
