/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port (matches devUrl in tauri.conf.json).
// 1430, not Tauri's default 1420: Windows winnat/Hyper-V reserves shifting port
// blocks (e.g. 1324-1423) and EACCES-blocks listening inside them.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  test: {
    // mcp/ is its own package with its own vitest; .claude/ holds worktree copies.
    exclude: ["**/node_modules/**", "**/dist/**", "mcp/**", ".claude/**"],
  },
});
