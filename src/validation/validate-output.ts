import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import type { CompilerRuntime } from "../shared/runtime";
import type { GeneratedFileRecord, ValidationDiagnostic, ValidationResult } from "../shared/types";

function normalizeFileKey(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function normalizeMessage(message: string | { getMessageText(): string; getNext?(): unknown } | unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (message && typeof message === "object" && "getMessageText" in message && typeof message.getMessageText === "function") {
    return message.getMessageText();
  }

  return String(message);
}

function createDiagnostic(
  filePath: string,
  code: string,
  message: string,
  line = 1,
  column = 1,
  category: ValidationDiagnostic["category"] = "error"
): ValidationDiagnostic {
  return {
    filePath,
    line,
    column,
    code,
    message,
    category
  };
}

function getLineAndColumn(sourceFile: SourceFile | undefined, start: number | undefined): { line: number; column: number } {
  if (!sourceFile || start === undefined) {
    return { line: 1, column: 1 };
  }

  return sourceFile.getLineAndColumnAtPos(start);
}

function hasMochaGlobals(content: string): boolean {
  return /\b(?:describe|context|it|specify|before|beforeEach|after|afterEach)\s*\(/.test(content);
}

function hasPlaywrightTestDefinitions(content: string): boolean {
  return /\btest(?:\.(?:only|skip))?\s*\(|\btest\.describe(?:\.(?:only|skip))?\s*\(/.test(content);
}

function hasValidSpecModuleImport(sourceFile: SourceFile, recordByOutputPath: Map<string, GeneratedFileRecord>): boolean {
  return sourceFile.getImportDeclarations().some((importDeclaration) => {
    if (
      importDeclaration.getDefaultImport() ||
      importDeclaration.getNamespaceImport() ||
      importDeclaration.getNamedImports().length > 0
    ) {
      return false;
    }

    const importedSourceFile = importDeclaration.getModuleSpecifierSourceFile();
    if (!importedSourceFile) {
      return false;
    }

    const importedRecord = recordByOutputPath.get(normalizeFileKey(importedSourceFile.getFilePath()));
    return importedRecord?.category === "spec" && importedRecord.specRole === "module";
  });
}

function findFirstMatchLocation(sourceFile: SourceFile, pattern: RegExp): { line: number; column: number } {
  const match = sourceFile.getFullText().match(pattern);
  if (!match || match.index === undefined) {
    return { line: 1, column: 1 };
  }

  return sourceFile.getLineAndColumnAtPos(match.index);
}

function buildSemanticDiagnostics(
  runtime: CompilerRuntime,
  project: Project,
  records: GeneratedFileRecord[]
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const recordBySourcePath = new Map(records.map((record) => [normalizeFileKey(record.sourcePath), record]));
  const recordByOutputPath = new Map(records.map((record) => [normalizeFileKey(record.outputPath), record]));

  for (const analysis of runtime.analysis?.files ?? []) {
    if (!analysis.specLike) {
      continue;
    }

    const record = recordBySourcePath.get(normalizeFileKey(analysis.sourcePath));
    const isOutsideSpecPipeline = !record || record.category !== "spec" || record.specRole === undefined;
    const isOutsideTestsTree = record ? !record.outputPath.includes(`${path.sep}tests${path.sep}`) : true;
    if (isOutsideSpecPipeline || isOutsideTestsTree) {
      diagnostics.push(
        createDiagnostic(
          record?.outputPath ?? analysis.generatedPath ?? analysis.sourcePath,
          "spec-like-outside-spec-pipeline",
          "Spec-like Cypress source was not emitted through the Playwright spec pipeline."
        )
      );
    }
  }

  for (const record of records) {
    const sourceFile = project.getSourceFile(normalizeFileKey(record.outputPath));
    if (!sourceFile) {
      continue;
    }

    const content = sourceFile.getFullText();

    if (record.category !== "support" && /\bcy\./.test(content)) {
      const location = findFirstMatchLocation(sourceFile, /\bcy\./);
      diagnostics.push(
        createDiagnostic(
          record.outputPath,
          "raw-cypress-output",
          "Generated Playwright output still contains raw Cypress API usage.",
          location.line,
          location.column
        )
      );
    }

    if (record.category === "helper" && hasMochaGlobals(content)) {
      const location = findFirstMatchLocation(sourceFile, /\b(?:describe|context|it|specify|before|beforeEach|after|afterEach)\s*\(/);
      diagnostics.push(
        createDiagnostic(
          record.outputPath,
          "helper-mocha-leak",
          "Helper output still contains Mocha globals and should have been routed through spec conversion.",
          location.line,
          location.column
        )
      );
    }

    if (record.category === "spec" && !hasPlaywrightTestDefinitions(content) && !hasValidSpecModuleImport(sourceFile, recordByOutputPath)) {
      diagnostics.push(
        createDiagnostic(
          record.outputPath,
          "empty-spec-output",
          "Generated spec has no Playwright suites/tests and no valid side-effect spec-module imports."
        )
      );
    }
  }

  return diagnostics;
}

export async function validateOutput(runtime: CompilerRuntime, records: GeneratedFileRecord[]): Promise<ValidationResult> {
  const toolRoot = path.resolve(__dirname, "..", "..");
  const generatedRoot = path.resolve(runtime.projectRoot, runtime.config.outputRoot);
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: false,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.resolve(toolRoot, "node_modules", "@types")],
      baseUrl: toolRoot,
      paths: {
        "@playwright/test": [path.resolve(toolRoot, "node_modules", "@playwright", "test")]
      }
    }
  });
  project.addSourceFilesAtPaths(path.resolve(generatedRoot, "**/*.ts"));
  project.addSourceFilesAtPaths(path.resolve(generatedRoot, "**/*.d.ts"));

  const diagnostics = project.getPreEmitDiagnostics();
  const normalizedDiagnostics: ValidationDiagnostic[] = diagnostics.map((diagnostic) => {
    const sourceFile = diagnostic.getSourceFile();
    const start = diagnostic.getStart();
    const location = getLineAndColumn(sourceFile, start);

    return {
      filePath: sourceFile?.getFilePath() ?? path.resolve(runtime.projectRoot, runtime.config.outputRoot, "unknown"),
      line: location.line,
      column: location.column,
      code: `ts-${diagnostic.getCode()}`,
      message: normalizeMessage(diagnostic.getMessageText()),
      category: diagnostic.getCategory() === 1 ? "error" : "warning"
    };
  });

  const semanticDiagnostics = buildSemanticDiagnostics(runtime, project, records);
  const allDiagnostics = [...normalizedDiagnostics, ...semanticDiagnostics];

  return {
    passed: allDiagnostics.every((diagnostic) => diagnostic.category !== "error"),
    diagnostics: allDiagnostics
  };
}
