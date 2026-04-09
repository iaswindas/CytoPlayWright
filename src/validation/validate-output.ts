import path from "node:path";
import { Project, ts } from "ts-morph";
import type { ValidationDiagnostic, ValidationResult } from "../shared/types";

function normalizeMessage(message: string | { getMessageText(): string; getNext?(): unknown } | unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (message && typeof message === "object" && "getMessageText" in message && typeof message.getMessageText === "function") {
    return message.getMessageText();
  }

  return String(message);
}

export async function validateOutput(projectRoot: string, outputRoot: string): Promise<ValidationResult> {
  const toolRoot = path.resolve(__dirname, "..", "..");
  const generatedRoot = path.resolve(projectRoot, outputRoot);
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
    const lineNumber = diagnostic.getLineNumber() ?? 1;
    const start = diagnostic.getStart() ?? 0;

    return {
      filePath: sourceFile?.getFilePath() ?? path.resolve(projectRoot, outputRoot, "unknown"),
      line: lineNumber,
      column: start,
      message: normalizeMessage(diagnostic.getMessageText()),
      category: diagnostic.getCategory() === 1 ? "error" : "warning"
    };
  });

  return {
    passed: normalizedDiagnostics.every((diagnostic) => diagnostic.category !== "error"),
    diagnostics: normalizedDiagnostics
  };
}
