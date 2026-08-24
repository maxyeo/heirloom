import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Last, so its rule-disabling wins: this turns off every ESLint rule that
  // is purely stylistic and would otherwise disagree with Prettier, so lint
  // stops asserting formatting Prettier already owns. It ships a single
  // flat-config object rather than an array like the Next presets above, so
  // it is not spread here.
  prettierConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
