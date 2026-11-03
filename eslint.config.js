import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeAwareRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "web/dist/**",
      "node_modules/**",
      "src-tauri/**",
      ".agent-team/**",
      "coverage/**",
      "web/playwright-report/**",
      "web/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Wrapped errors here already embed the original message or use AggregateError.
      "preserve-caught-error": "off",
      // Defensive initial values are intentional in the workflow and adapters.
      "no-useless-assignment": "off",
    },
  },
  {
    // `#name()` is a legal language feature, and in this repository it has one side effect
    // that is not about style: the CRAP tool's TypeScript parser does not see ECMAScript
    // private methods at all, so a function moved into `#name()` leaves the ledger while
    // staying in the code. That makes "extract it into a private method" a way to make the
    // number go down without changing anything — no red build, and nothing a reviewer can
    // see. Use TypeScript `private` instead: same compile-time guarantee, and the metric
    // can still see it. (Private *fields* are fine: they are not scored.)
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MethodDefinition[key.type='PrivateIdentifier']",
          message:
            "Use TypeScript `private` instead of `#`: the CRAP metric cannot see ECMAScript private methods, so complexity moved into one silently leaves the ledger.",
        },
      ],
    },
  },
  {
    // Type-aware rules only where files belong to a tsconfig project.
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: typeAwareRules,
  },
  {
    files: ["test/support/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...typeAwareRules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}", "web/e2e/**/*.ts", "web/*.ts", "scripts/**/*.{ts,mjs}", "*.js"],
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
