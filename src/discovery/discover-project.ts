import path from "node:path";
import fg from "fast-glob";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import type { CypwConfig } from "../config/types";
import type { DiscoveredFile, FileCategory, ProjectDiscovery, SourceLanguage } from "../shared/types";

const SOURCE_FILE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

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
  category: FileCategory
): DiscoveredFile {
  const relativePath = path.relative(projectRoot, sourceFile.getFilePath());
  const imports = sourceFile
    .getImportDeclarations()
    .map((importDeclaration) => importDeclaration.getModuleSpecifierValue());
  const commandUsages = countCypressCommands(sourceFile);
  const sourceLanguage = detectSourceLanguage(sourceFile.getFilePath());

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
      hasMocha: /(describe|context|it|specify|beforeEach|before|afterEach|after)\s*\(/.test(
        sourceFile.getFullText()
      ),
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
    discoveredFiles.push(buildDiscoveredFile(sourceFile, projectRoot, category));
  }

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
