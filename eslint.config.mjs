import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", "playwright-report/**", "release/**", "test-results/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.nodeBuiltin } },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["node:*", "electron", "@anthropic-ai/*", "@openai/*", "**/main/**", "**/worker/**"],
          message: "Renderer code may use only Renderer/shared contracts and the typed preload bridge",
        }],
      }],
    },
  },
);
