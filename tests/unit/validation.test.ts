import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/cli/create-runtime";
import { validateOutput } from "../../src/validation/validate-output";
import type { GeneratedFileRecord } from "../../src/shared/types";

const createdProjects: string[] = [];

afterEach(async () => {
  await Promise.allSettled(createdProjects.splice(0).map((projectRoot) => rm(projectRoot, { recursive: true, force: true })));
});

async function createValidationProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "cypw-validation-"));
  createdProjects.push(projectRoot);
  await mkdir(path.join(projectRoot, "cypress", "support"), { recursive: true });
  await mkdir(path.join(projectRoot, "playwright", "helpers"), { recursive: true });

  await writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs"
    }
  }, null, 2));
  await writeFile(path.join(projectRoot, "cypw.config.jsonc"), `{
  "version": "1",
  "sourceRoots": ["cypress"],
  "specGlobs": ["cypress/e2e/**/*.spec.ts"],
  "supportFile": "cypress/support/e2e.ts",
  "tsconfigPath": "tsconfig.json",
  "outputRoot": "playwright",
  "customCommandMap": {},
  "wrapperMap": { "aliasHelpers": [], "mappings": {} },
  "taskMap": {},
  "interceptPolicies": {},
  "pomRules": { "preserve": ["**/page-objects/**/*.ts", "**/*.page.ts"], "upgrade": ["**/page-objects/**/*.ts", "**/*.page.ts"], "regenerate": [] },
  "pluginModules": [],
  "runtimeRecipeModules": [],
  "typeFallbacks": { "externalModulesAsAny": true },
  "reporting": { "unresolvedThreshold": 0.8, "inlineTodoPrefix": "TODO(cypw)", "strictControlFlow": false, "maxBestEffortDepth": 2 }
}`);
  await writeFile(path.join(projectRoot, "cypress", "support", "e2e.ts"), "");
  await writeFile(path.join(projectRoot, "playwright", "helpers", "leak.ts"), "export function leak() { cy.get(\"button\").click(); }\n");

  return projectRoot;
}

describe("validate-output", () => {
  it("fails semantic validation when generated output still contains raw Cypress", async () => {
    const projectRoot = await createValidationProject();
    const runtime = await createRuntime(projectRoot);
    const records: GeneratedFileRecord[] = [
      {
        sourcePath: path.join(projectRoot, "cypress", "support", "e2e.ts"),
        outputPath: path.join(projectRoot, "playwright", "helpers", "leak.ts"),
        category: "helper",
        sourceLanguage: "ts",
        specLike: false,
        status: "converted",
        confidence: 0.97,
        issues: [],
        pluginHits: []
      }
    ];

    const validation = await validateOutput(runtime, records);
    expect(validation.passed).toBe(false);
    expect(validation.diagnostics.some((diagnostic) => diagnostic.code === "raw-cypress-output")).toBe(true);
  });
});
