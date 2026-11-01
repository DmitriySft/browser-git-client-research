import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "localhost",
    port: 5130,
    strictPort: true,
  },
  preview: {
    port: 5130,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
});
