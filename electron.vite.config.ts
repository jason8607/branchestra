import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BRANCHESTRA_PACKAGED_E2E__: JSON.stringify(process.env.BRANCHESTRA_BUILD_PACKAGED_E2E === "1")
    },
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts"), worker: resolve("src/worker/index.ts"), "provider-runner": resolve("src/provider-runner/index.ts") } } }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].js" }
      }
    }
  },
  renderer: { root: resolve("src/renderer"), plugins: [react()] }
});
