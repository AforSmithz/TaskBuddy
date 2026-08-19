import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated. aws/.build is the 41 MB Next standalone bundle and cdk.out is
    // the synthesized CloudFormation plus every esbuild artefact; linting either
    // reports thousands of problems in code nobody wrote.
    "aws/.build/**",
    "aws/infra/cdk.out/**",
  ]),
]);

export default eslintConfig;
