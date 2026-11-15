import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] },
    port: 5173,
  },
  build: { outDir: "dist", emptyOutDir: true },
});
