import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port (matches devUrl in tauri.conf.json).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
