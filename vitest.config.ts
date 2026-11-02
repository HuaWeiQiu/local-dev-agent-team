import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    exclude: [...configDefaults.exclude, ".agent-team/**"],
    coverage: {
      // Build output and earlier reports are not sources. Coverage is collected
      // for every file in the project (`all` defaults to true), so without this
      // the html assets under `target/coverage/**` were instrumented as untested
      // sources: a second run that clears that directory then killed the first
      // with `ENOENT ... lcov-report/sorter.js` from `V8ToIstanbul.load`, and the
      // quality gate read the crash as 0% coverage.
      exclude: [...configDefaults.coverage.exclude, "target/**", "coverage/**"],
      // Explicit and outside the instrumented tree, so a report is never written
      // into a directory this same run is scanning for sources.
      reportsDirectory: "target/coverage/typescript",
    },
  },
});
