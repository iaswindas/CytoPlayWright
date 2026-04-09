import path from "node:path";
import { cp } from "node:fs/promises";
import fg from "fast-glob";
import type { GeneratedArtifact, GeneratedFileRecord, MigrationStatus } from "../shared/types";
import type { CompilerRuntime } from "../shared/runtime";
import { CYPW_STATE_DIRECTORY } from "../shared/constants";
import { emptyDirectory, ensureDirectory, pathExists, writeTextFile } from "../shared/fs";
import { convertSourceFile } from "../transforms/convert-source-file";
import { renderMigrationFile } from "./codegen";
import {
  createBaseTestTemplate,
  createGeneratedTsconfigTemplate,
  createGlobalSetupTemplate,
  createPlaywrightConfigTemplate
} from "./templates";

function collectExternalModules(content: string): string[] {
  const matches = [...content.matchAll(/from\s+["']([^"']+)["']/g)];
  return matches
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && specifier !== "@playwright/test");
}

function createExternalModuleShims(modules: string[]): string {
  return `${modules.map((moduleName) => `declare module ${JSON.stringify(moduleName)};`).join("\n")}\n`;
}

function createMigrationReadme(jsFilesPresent: boolean, commonJsFilesPresent: boolean, externalModules: string[]): string {
  const lines = [
    "# cypw JS Migration Notes",
    "",
    "This Playwright tree was generated from Cypress JavaScript input and uses compile-safe TypeScript fallbacks.",
    "",
    jsFilesPresent ? "- JavaScript-origin files were converted to TypeScript with explicit `any` and `Record<string, any>` escapes where needed." : "- No JavaScript-origin files were detected.",
    commonJsFilesPresent ? "- CommonJS helpers/support files were rewritten for ES-module-compatible TypeScript output." : "- No CommonJS helper rewrites were needed."
  ];

  if (externalModules.length > 0) {
    lines.push("", "Likely third-party type packages to review:");
    for (const moduleName of externalModules) {
      lines.push(`- ${moduleName} (consider installing \`@types/${moduleName.replace(/^@/, "").replace(/\//g, "__")}\` if available)`);
    }
    lines.push("", "Fallback declaration shims were generated under `types/` for unresolved external modules.");
  }

  return `${lines.join("\n")}\n`;
}

function statusFromIssues(baseStatus: MigrationStatus, unresolvedCount: number): MigrationStatus {
  if (baseStatus === "unsupported" || baseStatus === "failed") {
    return baseStatus;
  }

  if (unresolvedCount > 0 && baseStatus === "converted") {
    return "converted_with_warnings";
  }

  if (unresolvedCount > 2) {
    return "manual_review";
  }

  return unresolvedCount > 0 ? "converted_with_warnings" : baseStatus;
}

export interface GenerationOutput {
  artifacts: GeneratedArtifact[];
  records: GeneratedFileRecord[];
}

export async function generateProject(runtime: CompilerRuntime): Promise<GenerationOutput> {
  if (!runtime.analysis) {
    throw new Error("Project analysis is missing.");
  }

  const outputRoot = path.resolve(runtime.projectRoot, runtime.config.outputRoot);
  await emptyDirectory(outputRoot);
  await ensureDirectory(path.resolve(runtime.projectRoot, CYPW_STATE_DIRECTORY));

  const artifacts: GeneratedArtifact[] = [];
  const records: GeneratedFileRecord[] = [];
  const externalModules = new Set<string>();
  let jsFilesPresent = false;
  let commonJsFilesPresent = false;

  const runtimeArtifacts: GeneratedArtifact[] = [
    {
      path: path.resolve(outputRoot, "fixtures", "baseTest.ts"),
      content: createBaseTestTemplate()
    },
    {
      path: path.resolve(outputRoot, "playwright.config.ts"),
      content: createPlaywrightConfigTemplate()
    },
    {
      path: path.resolve(outputRoot, "tsconfig.json"),
      content: createGeneratedTsconfigTemplate()
    }
  ];

  // Phase 5: Generate globalSetup if configured
  if (runtime.config.generateGlobalSetup) {
    runtimeArtifacts.push({
      path: path.resolve(outputRoot, "global-setup.ts"),
      content: createGlobalSetupTemplate()
    });
  }

  for (const runtimeArtifact of runtimeArtifacts) {
    artifacts.push(runtimeArtifact);
  }

  for (const fileAnalysis of runtime.analysis.files) {
    const ir = convertSourceFile(runtime, fileAnalysis.sourcePath);
    if (!ir) {
      continue;
    }

    let artifact: GeneratedArtifact = {
      path: ir.outputPath,
      content: renderMigrationFile(ir)
    };

    for (const plugin of runtime.plugins) {
      artifact = plugin.postGenerate?.({ artifact }) ?? artifact;
    }

    artifacts.push(artifact);
    jsFilesPresent ||= fileAnalysis.sourceLanguage === "js";
    commonJsFilesPresent ||= [...fileAnalysis.issues, ...ir.issues].some((issue) => issue.code === "commonjs-export");
    for (const moduleName of collectExternalModules(artifact.content)) {
      externalModules.add(moduleName);
    }
    const allIssues = [...fileAnalysis.issues, ...ir.issues];
    const unresolvedCount = allIssues.filter((issue) => issue.code === "manual-review" || issue.code.endsWith("review")).length;

    records.push({
      sourcePath: fileAnalysis.sourcePath,
      outputPath: ir.outputPath,
      category: fileAnalysis.category,
      sourceLanguage: fileAnalysis.sourceLanguage,
      status: statusFromIssues(fileAnalysis.status, unresolvedCount),
      confidence: fileAnalysis.confidence,
      issues: allIssues,
      pluginHits: [...new Set([...fileAnalysis.pluginCandidates, ...("pluginHits" in ir ? ir.pluginHits : [])])]
    });
  }

  if (externalModules.size > 0 && runtime.config.typeFallbacks?.externalModulesAsAny !== false) {
    artifacts.push({
      path: path.resolve(outputRoot, "types", "external-modules.d.ts"),
      content: createExternalModuleShims([...externalModules].sort())
    });
  }

  if (jsFilesPresent || commonJsFilesPresent || externalModules.size > 0) {
    artifacts.push({
      path: path.resolve(outputRoot, "README.md"),
      content: createMigrationReadme(jsFilesPresent, commonJsFilesPresent, [...externalModules].sort())
    });
  }

  for (const artifact of artifacts) {
    await writeTextFile(artifact.path, artifact.content);
  }

  // Phase 5: Copy fixture files to output tree
  if (runtime.config.copyFixtures !== false) {
    const fixtureSourceDir = path.resolve(runtime.projectRoot, "cypress", "fixtures");
    if (await pathExists(fixtureSourceDir)) {
      const posixFixtureDir = fixtureSourceDir.split(path.sep).join("/");
      const fixtureFiles = await fg(
        `${posixFixtureDir}/**/*.{json,csv,txt,xml,yaml,yml}`,
        { absolute: true, onlyFiles: true }
      );
      for (const fixtureFile of fixtureFiles) {
        const fixtureRelative = path.basename(fixtureFile);
        const outputFixturePath = path.resolve(outputRoot, "fixtures", "data", fixtureRelative);
        await ensureDirectory(path.dirname(outputFixturePath));
        const nativeFixtureFile = fixtureFile.split("/").join(path.sep);
        if (await pathExists(nativeFixtureFile)) {
          await cp(nativeFixtureFile, outputFixturePath, { recursive: false });
        }
      }
    }
  }

  return {
    artifacts,
    records
  };
}
