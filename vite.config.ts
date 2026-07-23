/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port (matches devUrl in tauri.conf.json).
// 1630, not Tauri's default 1420: Windows winnat/Hyper-V reserves shifting port
// blocks and EACCES-blocks listening inside them. That block has since grown to
// cover 1359-1558, which swallowed the previous choice (1430) — check with
// `netsh interface ipv4 show excludedportrange protocol=tcp` before moving it.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1630,
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
