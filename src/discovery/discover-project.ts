import path from "node:path";
import fg from "fast-glob";
import { Node, Project, SyntaxKind, type Expression, type SourceFile } from "ts-morph";
import type { CypwConfig } from "../config/types";
import type { DiscoveredFile, FileCategory, ProjectDiscovery, SourceLanguage, SpecRole } from "../shared/types";

const SOURCE_FILE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";
const MOCHA_API_NAMES = new Set(["describe", "context", "it", "specify", "before", "beforeEach", "after", "afterEach"]);

function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function normalizeSpecGlobs(specGlobs: string[]): string[] {
  return specGlobs.map((pattern) => pattern.replace(/\\/g, "/"));
}

function categoryFromPath(filePath: string, specFiles: Set<string>, supportFilePath?: string): FileCategory {
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (specFiles.has(normalizedPath)) {
    return "spec";
  }

  if (
    normalizedPath.includes("/support/helpers/") ||
    normalizedPath.includes("/support/utils/") ||
    normalizedPath.includes("/helpers/")
  ) {
    return "helper";
  }

  if (supportFilePath && normalizedPath === supportFilePath) {
    return "support";
  }

  if (normalizedPath.includes("/support/")) {
    return "support";
  }

  if (normalizedPath.includes("/fixtures/")) {
    return "fixture";
  }

  if (normalizedPath.includes("/page-objects/") || /\.page\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalizedPath)) {
    return "page-object";
  }
  return "other";
}

function detectSourceLanguage(filePath: string): SourceLanguage {
  return /\.(ts|tsx)$/.test(filePath) ? "ts" : "js";
}

function getCallBaseName(expression: Expression): string | undefined {
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return getCallBaseName(expression.getExpression());
  }

  if (Node.isCallExpression(expression)) {
    return getCallBaseName(expression.getExpression());
  }

  return undefined;
}

function detectMochaUsage(sourceFile: SourceFile): boolean {
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((callExpression) => {
    const baseName = getCallBaseName(callExpression.getExpression());
    return Boolean(baseName && MOCHA_API_NAMES.has(baseName));
  });
}

function countCypressCommands(sourceFile: SourceFile): Record<string, number> {
  const counts: Record<string, number> = {};
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const callExpression of callExpressions) {
    const expression = callExpression.getExpression();
    if (!expression || !expression.asKind(SyntaxKind.PropertyAccessExpression)) {
      continue;
    }

    const propertyAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const commandName = propertyAccess.getName();
    const expressionText = propertyAccess.getExpression().getText();

    if (expressionText === "cy" || expressionText.startsWith("cy.")) {
      counts[commandName] = (counts[commandName] ?? 0) + 1;
    }
  }

  return counts;
}

function getCustomCommands(sourceFile: SourceFile): string[] {
  const customCommands = new Set<string>();
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const callExpression of callExpressions) {
    const expressionText = callExpression.getExpression().getText();
    if (expressionText !== "Cypress.Commands.add") {
      continue;
    }

    const [firstArg] = callExpression.getArguments();
    if (firstArg && firstArg.getKind() === SyntaxKind.StringLiteral) {
      customCommands.add(firstArg.getText().slice(1, -1));
    }
  }

  return [...customCommands];
}

function getExports(sourceFile: SourceFile): string[] {
  return [...sourceFile.getExportedDeclarations().keys()];
}

function buildDiscoveredFile(
  sourceFile: SourceFile,
  projectRoot: string,
  category: FileCategory,
  specEntries: Set<string>
): DiscoveredFile {
  const relativePath = path.relative(projectRoot, sourceFile.getFilePath());
  const imports = sourceFile
    .getImportDeclarations()
    .map((importDeclaration) => importDeclaration.getModuleSpecifierValue());
  const commandUsages = countCypressCommands(sourceFile);
  const sourceLanguage = detectSourceLanguage(sourceFile.getFilePath());
  const normalizedPath = sourceFile.getFilePath().replace(/\\/g, "/");
  const hasMocha = detectMochaUsage(sourceFile);
  const specEntry = specEntries.has(normalizedPath);

  return {
    path: sourceFile.getFilePath(),
    relativePath,
    category,
    imports,
    exports: getExports(sourceFile),
    customCommands: getCustomCommands(sourceFile),
    metadata: {
      sourceLanguage,
      hasCypress: sourceFile.getFullText().includes("cy."),
      hasMocha,
      specLike: hasMocha,
      specEntry,
      specRole: specEntry ? "entry" : undefined,
      hasPageObjectClass: sourceFile.getClasses().some((classDeclaration) =>
        /page/i.test(classDeclaration.getName() ?? "")
      ),
      hasIntercept: Boolean(commandUsages.intercept),
      hasTask: Boolean(commandUsages.task),
      hasFixture: Boolean(commandUsages.fixture),
      hasRequest: Boolean(commandUsages.request),
      commandUsages
    }
  };
}

function assignSpecRoles(discoveredFiles: DiscoveredFile[], sourceFileMap: Map<string, SourceFile>): void {
  const filesByPath = new Map(discoveredFiles.map((file) => [file.path, file]));
  const normalizedSourcePaths = new Map([...sourceFileMap.keys()].map((filePath) => [normalizeFilePath(filePath), filePath]));
  const specPipelinePaths = new Set(
    discoveredFiles
      .filter((file) => file.metadata.specEntry || file.metadata.specLike)
      .map((file) => file.path)
  );
  const dependents = new Map<string, Set<string>>();

  for (const file of discoveredFiles) {
    const sourceFile = sourceFileMap.get(file.path);
    if (!sourceFile) {
      continue;
    }

    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const dependencyPath = resolveImportedFilePath(sourceFile, importDeclaration.getModuleSpecifierValue(), normalizedSourcePaths)
        ?? importDeclaration.getModuleSpecifierSourceFile()?.getFilePath();
      if (!dependencyPath) {
        continue;
      }

      if (!filesByPath.has(dependencyPath)) {
        continue;
      }

      const existing = dependents.get(dependencyPath) ?? new Set<string>();
      existing.add(file.path);
      dependents.set(dependencyPath, existing);
    }
  }

  for (const file of discoveredFiles) {
    if (!file.metadata.specEntry && !file.metadata.specLike) {
      continue;
    }

    const specDependents = [...(dependents.get(file.path) ?? new Set<string>())].filter((dependentPath) =>
      specPipelinePaths.has(dependentPath)
    );
    const specRole: SpecRole = file.metadata.specEntry || specDependents.length === 0 ? "entry" : "module";
    file.metadata.specRole = specRole;
    file.category = "spec";
  }
}

function resolveImportedFilePath(
  sourceFile: SourceFile,
  moduleSpecifier: string,
  normalizedSourcePaths: Map<string, string>
): string | undefined {
  if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
    return undefined;
  }

  const candidatePaths = [
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.ts`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.tsx`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.js`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.jsx`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.mjs`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.cjs`),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.ts"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.tsx"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.js"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.jsx"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.mjs"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.cjs")
  ];

  for (const candidatePath of candidatePaths) {
    const normalizedCandidatePath = normalizeFilePath(candidatePath);
    const resolvedPath = normalizedSourcePaths.get(normalizedCandidatePath);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return undefined;
}

export interface DiscoveryRuntime {
  discovery: ProjectDiscovery;
  project: Project;
  sourceFileMap: Map<string, SourceFile>;
}

export async function discoverProject(projectRoot: string, config: CypwConfig): Promise<DiscoveryRuntime> {
  const specPatterns = normalizeSpecGlobs(config.specGlobs);
  const absoluteSpecPatterns = specPatterns.map((pattern) => path.posix.join(projectRoot.replace(/\\/g, "/"), pattern));
  const matchedSpecFiles = await fg(absoluteSpecPatterns, { absolute: true, onlyFiles: true });
  const normalizedSpecFiles = new Set(matchedSpecFiles.map((entry) => entry.replace(/\\/g, "/")));

  const allTypeScriptFiles = await fg(
    config.sourceRoots.map((root) => path.posix.join(projectRoot.replace(/\\/g, "/"), root, SOURCE_FILE_GLOB)),
    {
      absolute: true,
      onlyFiles: true
    }
  );

  const supportFilePath = config.supportFile
    ? path.resolve(projectRoot, config.supportFile).replace(/\\/g, "/")
    : undefined;

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      module: 1,
      target: 9
    }
  });

  project.addSourceFilesAtPaths(allTypeScriptFiles);

  const discoveredFiles: DiscoveredFile[] = [];
  const sourceFileMap = new Map<string, SourceFile>();

  for (const sourceFile of project.getSourceFiles()) {
    sourceFileMap.set(sourceFile.getFilePath(), sourceFile);
    const category = categoryFromPath(sourceFile.getFilePath(), normalizedSpecFiles, supportFilePath);
    discoveredFiles.push(buildDiscoveredFile(sourceFile, projectRoot, category, normalizedSpecFiles));
  }

  assignSpecRoles(discoveredFiles, sourceFileMap);

  const categorized = {
    specFiles: discoveredFiles.filter((file) => file.category === "spec"),
    pageObjects: discoveredFiles.filter((file) => file.category === "page-object"),
    helpers: discoveredFiles.filter((file) => file.category === "helper"),
    supportFiles: discoveredFiles.filter((file) => file.category === "support"),
    fixtures: discoveredFiles.filter((file) => file.category === "fixture"),
    utilityFiles: discoveredFiles.filter((file) => file.category === "utility"),
    otherFiles: discoveredFiles.filter((file) => file.category === "other")
  };

  const customCommands = new Set<string>();
  for (const file of discoveredFiles) {
    for (const customCommand of file.customCommands) {
      customCommands.add(customCommand);
    }
  }

  return {
    project,
    sourceFileMap,
    discovery: {
      projectRoot,
      sourceRootPaths: config.sourceRoots.map((root) => path.resolve(projectRoot, root)),
      ...categorized,
      customCommands: [...customCommands],
      allFiles: discoveredFiles
    }
  };
}
