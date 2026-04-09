import { describe, expect, it } from "vitest";
import { renderMigrationFile } from "../../src/generation/codegen";
import type { SpecFileIR } from "../../src/ir/types";

describe("codegen", () => {
  it("renders side-effect imports for shell specs", () => {
    const ir: SpecFileIR = {
      kind: "spec",
      sourcePath: "/project/cypress/e2e/flow/entry.spec.ts",
      outputPath: "/project/playwright/tests/flow/entry.spec.ts",
      imports: [
        {
          moduleSpecifier: "./shared",
          sideEffectOnly: true
        }
      ],
      suites: [],
      issues: [],
      pluginHits: []
    };

    const rendered = renderMigrationFile(ir);
    expect(rendered).toContain("import \"./shared\";");
    expect(rendered).not.toContain("import  from");
  });
});
