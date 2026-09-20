import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "dashboard",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./dashboard/src", import.meta.url)) },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    license: { fileName: "LICENSES.md" },
    rolldownOptions: {
      output: {
        entryFileNames: "dashboard.js",
        assetFileNames: "dashboard[extname]",
      },
    },
  },
});
