import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0"),
    __APP_BUILD_ID__: JSON.stringify("2026.08.17-github-changes"),
  },
  test: {
    exclude: [...configDefaults.exclude, ".agent-team/**", ".analysis/**"],
  },
});
