import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "localhost",
    port: 5170,
    strictPort: true,
  },
  preview: {
    port: 5170,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
});
