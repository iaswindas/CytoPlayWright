import { describe, expect, it } from "vitest";
import { buildPathResolution } from "../../src/shared/path-resolution";
import type { ProjectDiscovery, DiscoveredFile } from "../../src/shared/types";
import type { CypwConfig } from "../../src/config/types";

function createMockFile(
  filePath: string,
  category: DiscoveredFile["category"],
  metadata: Partial<DiscoveredFile["metadata"]> = {}
): DiscoveredFile {
  return {
    path: filePath,
    relativePath: filePath,
    category,
    imports: [],
    exports: [],
    customCommands: [],
    metadata: {
      sourceLanguage: "ts",
      hasCypress: true,
      hasMocha: true,
      specLike: category === "spec",
      specEntry: category === "spec",
      specRole: category === "spec" ? "entry" : undefined,
      hasPageObjectClass: false,
      hasIntercept: false,
      hasTask: false,
      hasFixture: false,
      hasRequest: false,
      commandUsages: {},
      ...metadata
    }
  };
}

function createMockDiscovery(files: DiscoveredFile[]): ProjectDiscovery {
  return {
    projectRoot: "/project",
    sourceRootPaths: ["/project/cypress"],
    specFiles: files.filter((f) => f.category === "spec"),
    pageObjects: files.filter((f) => f.category === "page-object"),
    helpers: files.filter((f) => f.category === "helper"),
    supportFiles: files.filter((f) => f.category === "support"),
    fixtures: files.filter((f) => f.category === "fixture"),
    utilityFiles: [],
    otherFiles: files.filter((f) => f.category === "other"),
    customCommands: [],
    allFiles: files
  };
}

describe("path-resolution", () => {
  it("maps spec files to tests/ directory", () => {
    const files = [
      createMockFile("/project/cypress/e2e/auth/login.spec.ts", "spec")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/e2e/auth/login.spec.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("tests");
    expect(mapped).toContain("login.spec.ts");
  });

  it("normalizes promoted entry specs to .spec.ts output", () => {
    const files = [
      createMockFile("/project/cypress/e2e/flow/shared.ts", "spec", {
        specLike: true,
        specEntry: false,
        specRole: "entry"
      })
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/e2e/flow/shared.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("shared.spec.ts");
  });

  it("emits spec modules as non-collected .ts files", () => {
    const files = [
      createMockFile("/project/cypress/e2e/flow/shared.ts", "spec", {
        specLike: true,
        specEntry: false,
        specRole: "module"
      })
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/e2e/flow/shared.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("tests");
    expect(mapped).toContain("shared.ts");
    expect(mapped).not.toContain("shared.spec.ts");
  });

  it("maps page-objects to page-objects/ directory", () => {
    const files = [
      createMockFile("/project/cypress/page-objects/login.page.ts", "page-object")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/page-objects/login.page.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("page-objects");
  });

  it("maps support files to support/ directory", () => {
    const files = [
      createMockFile("/project/cypress/support/commands.ts", "support")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/support/commands.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("support");
  });

  it("maps helpers to helpers/ directory", () => {
    const files = [
      createMockFile("/project/cypress/support/helpers/navigation.ts", "helper")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const mapped = resolution.sourceToOutput.get("/project/cypress/support/helpers/navigation.ts");
    expect(mapped).toBeDefined();
    expect(mapped).toContain("helpers");
  });

  it("creates bidirectional mappings", () => {
    const files = [
      createMockFile("/project/cypress/e2e/test.spec.ts", "spec")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    const output = resolution.sourceToOutput.get("/project/cypress/e2e/test.spec.ts");
    if (output) {
      const reverse = resolution.outputToSource.get(output);
      expect(reverse).toBe("/project/cypress/e2e/test.spec.ts");
    }
  });

  it("skips fixture files (no output path)", () => {
    const files = [
      createMockFile("/project/cypress/fixtures/user.json", "fixture")
    ];
    const resolution = buildPathResolution({
      projectRoot: "/project",
      config: { outputRoot: "playwright" } as CypwConfig,
      discovery: createMockDiscovery(files)
    });

    expect(resolution.sourceToOutput.has("/project/cypress/fixtures/user.json")).toBe(false);
  });
});
