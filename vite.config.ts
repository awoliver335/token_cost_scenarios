import { defineConfig } from "vite";

export default defineConfig({
  base: "/token_cost_scenarios/",
  build: {
    chunkSizeWarningLimit: 3000,
  },
});
