import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts"), worker: resolve("src/worker/index.ts") } } }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { root: resolve("src/renderer"), plugins: [react()] }
});
