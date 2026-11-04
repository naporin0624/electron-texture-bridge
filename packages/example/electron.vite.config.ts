import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          receiver: resolve("src/preload/receiver.ts"),
          multiviewer: resolve("src/preload/multiviewer.ts"),
          "preview-strip": resolve("src/preload/preview-strip.ts"),
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "receiver-test": resolve("src/renderer/receiver-test.html"),
          "grid-demo": resolve("src/renderer/grid-demo.html"),
          multiviewer: resolve("src/renderer/multiviewer.html"),
          "preview-strip": resolve("src/renderer/preview-strip.html"),
        },
      },
    },
    worker: {
      format: "es",
    },
  },
});
