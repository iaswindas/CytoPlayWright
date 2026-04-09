import type { MigrationFileIR } from "../ir/types";
import type { CompilerRuntime } from "../shared/runtime";
import type { GeneratedFileRecord } from "../shared/types";
import { transformHelperFile } from "./helper-transformer";
import { transformPageObject } from "./page-object-transformer";
import { transformSpecFile } from "./spec-to-ir";
import { transformSupportFile } from "./support-transformer";

export function convertSourceFile(runtime: CompilerRuntime, sourcePath: string): MigrationFileIR | undefined {
  const sourceFile = runtime.sourceFileMap.get(sourcePath);
  const analysis = runtime.analysis?.files.find((file) => file.sourcePath === sourcePath);

  if (!sourceFile || !analysis) {
    return undefined;
  }

  switch (analysis.category) {
    case "spec":
      return transformSpecFile(runtime, sourceFile, analysis);
    case "page-object":
      return transformPageObject(runtime, sourceFile, analysis);
    case "support":
      return transformSupportFile(runtime, sourcePath, analysis);
    case "helper":
      return transformHelperFile(runtime, sourceFile, analysis);
    case "other":
      if (sourceFile.getFullText().includes("cy.")) {
        return transformHelperFile(runtime, sourceFile, analysis);
      }
      return undefined;
    default:
      return undefined;
  }
}

export function findAnalysisRecord(runtime: CompilerRuntime, sourcePath: string): GeneratedFileRecord | undefined {
  const analysis = runtime.analysis?.files.find((file) => file.sourcePath === sourcePath);
  if (!analysis?.generatedPath) {
    return undefined;
  }

  return {
    sourcePath,
    outputPath: analysis.generatedPath,
    category: analysis.category,
    sourceLanguage: analysis.sourceLanguage,
    status: analysis.status,
    confidence: analysis.confidence,
    issues: analysis.issues,
    pluginHits: analysis.pluginCandidates
  };
}
