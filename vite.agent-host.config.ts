import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "out/agent-host",
    emptyOutDir: true,
    sourcemap: true,
    ssr: true,
    rollupOptions: {
      input: {
        index: resolve("src/agent-host/main.ts"),
        worker: resolve("src/agent-host/worker-main.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].mjs",
      },
    },
  },
});
