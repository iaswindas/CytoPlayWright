import { DEFAULT_OUTPUT_ROOT } from "../shared/constants";
import type { CypwConfig } from "./types";

export function createDefaultConfig(): CypwConfig {
  return {
    version: "1",
    sourceRoots: ["cypress"],
    specGlobs: [
      "cypress/e2e/**/*.cy.ts",
      "cypress/e2e/**/*.spec.ts",
      "cypress/e2e/**/*.ts",
      "cypress/e2e/**/*.cy.js",
      "cypress/e2e/**/*.spec.js",
      "cypress/e2e/**/*.js",
      "cypress/e2e/**/*.cy.jsx",
      "cypress/e2e/**/*.spec.jsx",
      "cypress/e2e/**/*.jsx",
      "cypress/e2e/**/*.mjs",
      "cypress/e2e/**/*.cjs"
    ],
    supportFile: "cypress/support/e2e.ts",
    tsconfigPath: "tsconfig.json",
    outputRoot: DEFAULT_OUTPUT_ROOT,
    customCommandMap: {},
    wrapperMap: {
      aliasHelpers: [],
      mappings: {}
    },
    taskMap: {},
    interceptPolicies: {},
    pomRules: {
      preserve: ["**/page-objects/**/*.ts", "**/*.page.ts"],
      upgrade: ["**/page-objects/**/*.ts", "**/*.page.ts"],
      regenerate: []
    },
    pluginModules: [],
    runtimeRecipeModules: [],
    typeFallbacks: {
      externalModulesAsAny: true
    },
    reporting: {
      unresolvedThreshold: 0.8,
      inlineTodoPrefix: "TODO(cypw)",
      strictControlFlow: false,
      maxBestEffortDepth: 2
    }
  };
}
