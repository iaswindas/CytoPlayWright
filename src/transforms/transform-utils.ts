import path from "node:path";
import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type CommentRange,
  type ClassDeclaration,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type Node as MorphNode,
  type SourceFile,
  type Statement
} from "ts-morph";
import type { CommentIR } from "../ir/types";
import type { FileAnalysis, MigrationIssue, SubjectKind } from "../shared/types";
import type { CompilerRuntime } from "../shared/runtime";
import type { CommandTranslationResult, RuntimeRecipeResult } from "../plugins/types";
import { rewriteCypressGlobals } from "./env-transform";

export interface TransformState {
  aliasKinds: Map<string, SubjectKind | "intercept">;
  bindingKinds: Map<string, SubjectKind>;
  tempVariableCounter: number;
}

export interface TransformContext {
  runtime: CompilerRuntime;
  sourceFile: SourceFile;
  pageIdentifier: string;
  requestIdentifier: string;
  loadFixtureIdentifier: string;
  runTaskIdentifier: string;
  migrationStateIdentifier: string;
  fileAnalysis: FileAnalysis;
  pluginHits: Set<string>;
  helperCallNamesNeedingPage: Set<string>;
  pageObjectClassNames: Set<string>;
  state: TransformState;
  controlFlowDepth: number;
  hoistedAliases: Map<string, SubjectKind>;
}

export interface CommandLink {
  name: string;
  call: CallExpression;
}

export function getNodeLocation(node: MorphNode): { line: number; column: number } {
  const position = node.getStartLinePos();
  return {
    line: node.getStartLineNumber(),
    column: node.getStart() - position + 1
  };
}

export function createIssue(
  node: MorphNode,
  sourcePath: string,
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "warning",
  pattern?: string,
  conversionStrategy?: MigrationIssue["conversionStrategy"],
  metadata?: Pick<MigrationIssue, "aliasHoisted" | "forcedSerialMode">
): MigrationIssue {
  return {
    code,
    message,
    severity,
    sourcePath,
    location: getNodeLocation(node),
    pattern,
    snippet: node.getText(),
    conversionStrategy,
    ...metadata
  };
}

export function indentBlock(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

export function normalizeImportPath(fromFile: string, targetFile: string): string {
  let relativePath = path.relative(path.dirname(fromFile), targetFile).replace(/\\/g, "/");
  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }

  return relativePath.replace(/\.ts$/, "");
}

export function isFunctionLikeWithBody(statement: Statement): boolean {
  return (
    Node.isFunctionDeclaration(statement) ||
    Node.isVariableStatement(statement) ||
    Node.isClassDeclaration(statement)
  );
}

export function getPageObjectClassNames(runtime: CompilerRuntime): Set<string> {
  const names = new Set<string>();
  for (const pageObject of runtime.discovery.pageObjects) {
    const sourceFile = runtime.sourceFileMap.get(pageObject.path);
    if (!sourceFile) {
      continue;
    }

    for (const classDeclaration of sourceFile.getClasses()) {
      const className = classDeclaration.getName();
      if (className) {
        names.add(className);
      }
    }
  }

  return names;
}

export function getHelperImportsNeedingPage(sourceFile: SourceFile, runtime: CompilerRuntime): Set<string> {
  const helperNames = new Set<string>();

  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    const importedFile = importDeclaration.getModuleSpecifierSourceFile();
    if (!importedFile) {
      continue;
    }

    const discovered = runtime.discovery.allFiles.find((file) => file.path === importedFile.getFilePath());
    if (!discovered) {
      continue;
    }

    if (discovered.category !== "helper" && !(discovered.category === "other" && discovered.metadata.hasCypress)) {
      continue;
    }

    for (const namedImport of importDeclaration.getNamedImports()) {
      helperNames.add(namedImport.getName());
    }
  }

  return helperNames;
}

export function tryParseCypressChain(expression: Expression): CommandLink[] | undefined {
  if (!Node.isCallExpression(expression)) {
    return undefined;
  }

  const callee = expression.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const previousExpression = callee.getExpression();
  const commandName = callee.getName();

  if (Node.isIdentifier(previousExpression) && previousExpression.getText() === "cy") {
    return [{ name: commandName, call: expression }];
  }

  const previousChain = tryParseCypressChain(previousExpression);
  if (!previousChain) {
    return undefined;
  }

  return [...previousChain, { name: commandName, call: expression }];
}

export function getStringLiteralValue(expression?: Expression): string | undefined {
  if (!expression) {
    return undefined;
  }

  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralText();
  }

  return undefined;
}

export function resolveCommandViaPlugins(
  context: TransformContext,
  commandCall: CallExpression,
  commandName: string,
  args: string[]
): CommandTranslationResult | undefined {
  for (const plugin of context.runtime.plugins) {
    const result = plugin.translateCommand?.({
      sourceFile: context.sourceFile,
      callExpression: commandCall,
      commandName,
      args,
      pageIdentifier: context.pageIdentifier
    });

    if (result) {
      context.pluginHits.add(plugin.name);
      return result;
    }
  }

  return undefined;
}

export function resolveRuntimeRecipeViaPlugins(
  context: TransformContext,
  callback: ArrowFunction | FunctionExpression,
  windowIdentifier: string
): RuntimeRecipeResult | undefined {
  for (const plugin of context.runtime.plugins) {
    const result = plugin.translateRuntimeRecipe?.({
      sourceFile: context.sourceFile,
      callback,
      windowIdentifier,
      pageIdentifier: context.pageIdentifier
    });

    if (result) {
      context.pluginHits.add(plugin.name);
      return result;
    }
  }

  return undefined;
}

export function rewriteNewExpressionIfNeeded(
  expressionText: string,
  initializer: Expression,
  pageObjectClassNames: Set<string>,
  pageIdentifier: string
): string {
  if (!Node.isNewExpression(initializer)) {
    return expressionText;
  }

  const expression = initializer.getExpression();
  if (!Node.isIdentifier(expression)) {
    return expressionText;
  }

  const className = expression.getText();
  if (!pageObjectClassNames.has(className)) {
    return expressionText;
  }

  const args = initializer.getArguments().map((argument) => argument.getText());
  if (args.length === 0) {
    return `new ${className}(${pageIdentifier})`;
  }

  return `new ${className}(${[pageIdentifier, ...args].join(", ")})`;
}

export function getTopLevelClass(sourceFile: SourceFile): ClassDeclaration | undefined {
  return sourceFile.getClasses()[0];
}

export function isIdentifierNamed(node: Expression, name: string): node is Identifier {
  return Node.isIdentifier(node) && node.getText() === name;
}

export function getStatementText(statement: Statement): string {
  return statement.getText();
}

export function isJavaScriptSource(context: Pick<TransformContext, "fileAnalysis">): boolean {
  return context.fileAnalysis.sourceLanguage === "js";
}

export function hasAsyncWork(code: string): boolean {
  return code.includes("await ");
}

export function needsPageArgumentInjection(
  callExpression: CallExpression,
  helperFunctionNames: Set<string>
): boolean {
  const expression = callExpression.getExpression();
  return Node.isIdentifier(expression) && helperFunctionNames.has(expression.getText());
}

export function renderArguments(callExpression: CallExpression): string[] {
  return callExpression.getArguments().map((argument) => argument.getText());
}

export function getRequireCall(callExpression?: Expression): { moduleSpecifier: string } | undefined {
  if (!callExpression || !Node.isCallExpression(callExpression)) {
    return undefined;
  }

  const expression = callExpression.getExpression();
  if (!Node.isIdentifier(expression) || expression.getText() !== "require") {
    return undefined;
  }

  const firstArg = callExpression.getArguments()[0];
  if (!firstArg || !Node.isStringLiteral(firstArg) && !Node.isNoSubstitutionTemplateLiteral(firstArg)) {
    return undefined;
  }

  const moduleSpecifier = getStringLiteralValue(firstArg);
  if (!moduleSpecifier) {
    return undefined;
  }

  return { moduleSpecifier };
}

export function isExternalModuleSpecifier(moduleSpecifier: string): boolean {
  return !moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/") && !moduleSpecifier.startsWith("node:");
}

export function resolveModuleImportSpecifier(
  context: TransformContext,
  sourceFile: SourceFile,
  outputPath: string,
  moduleSpecifier: string
): string {
  if (isExternalModuleSpecifier(moduleSpecifier)) {
    return moduleSpecifier;
  }

  const candidatePaths = [
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.js`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.ts`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.jsx`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.tsx`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.cjs`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.mjs`),
    path.resolve(sourceFile.getDirectoryPath(), `${moduleSpecifier}.json`),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.js"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.ts"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.jsx"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.tsx"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.cjs"),
    path.resolve(sourceFile.getDirectoryPath(), moduleSpecifier, "index.mjs")
  ];

  const resolved = candidatePaths.find((candidatePath) => context.runtime.pathResolution.sourceToOutput.has(candidatePath) || sourceFile.getProject().getFileSystem().fileExistsSync(candidatePath));
  if (!resolved) {
    return moduleSpecifier;
  }

  const convertedPath = context.runtime.pathResolution.sourceToOutput.get(resolved) ?? resolved;
  return normalizeImportPath(outputPath, convertedPath);
}

export function isMutableObjectLiteral(initializer: Expression): boolean {
  return Node.isObjectLiteralExpression(initializer) && initializer.getProperties().length === 0;
}

export function isMutableArrayLiteral(initializer: Expression): boolean {
  return Node.isArrayLiteralExpression(initializer) && initializer.getElements().length === 0;
}

export function resolveExplicitAnyType(initializer?: Expression): string | undefined {
  if (!initializer) {
    return undefined;
  }

  if (isMutableObjectLiteral(initializer)) {
    return "Record<string, any>";
  }

  if (isMutableArrayLiteral(initializer)) {
    return "any[]";
  }

  if (Node.isAwaitExpression(initializer) || Node.isCallExpression(initializer) || Node.isPropertyAccessExpression(initializer)) {
    return "any";
  }

  return undefined;
}

export function hasIdentifierMutationInScope(declarationName: string, declaration: MorphNode): boolean {
  const block = declaration.getFirstAncestorByKind(SyntaxKind.Block);
  if (!block) {
    return false;
  }

  return block.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((binaryExpression) => {
    if (binaryExpression.getStart() <= declaration.getStart()) {
      return false;
    }

    const operator = binaryExpression.getOperatorToken().getKind();
    if (operator !== SyntaxKind.EqualsToken) {
      return false;
    }

    const left = binaryExpression.getLeft();
    if (Node.isIdentifier(left)) {
      return left.getText() === declarationName;
    }

    if (Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left)) {
      return left.getExpression().getText() === declarationName;
    }

    return false;
  });
}

export function getResolvedSourceOutputPath(runtime: CompilerRuntime, sourcePath: string): string | undefined {
  return runtime.pathResolution.sourceToOutput.get(sourcePath);
}

export function createTransformState(): TransformState {
  return {
    aliasKinds: new Map(),
    bindingKinds: new Map(),
    tempVariableCounter: 0
  };
}

export function createChildTransformContext(
  context: TransformContext,
  overrides: Partial<Pick<TransformContext, "pageIdentifier" | "controlFlowDepth" | "hoistedAliases">> = {}
): TransformContext {
  return {
    ...context,
    pageIdentifier: overrides.pageIdentifier ?? context.pageIdentifier,
    controlFlowDepth: overrides.controlFlowDepth ?? context.controlFlowDepth,
    hoistedAliases: overrides.hoistedAliases ?? context.hoistedAliases,
    state: {
      ...context.state,
      aliasKinds: context.state.aliasKinds,
      bindingKinds: new Map(context.state.bindingKinds),
      tempVariableCounter: context.state.tempVariableCounter
    }
  };
}

export function nextTempVariable(context: TransformContext, prefix: string): string {
  context.state.tempVariableCounter += 1;
  return `${prefix}${context.state.tempVariableCounter}`;
}

export function bindSubjectKind(context: TransformContext, identifier: string, kind: SubjectKind): void {
  context.state.bindingKinds.set(identifier, kind);
}

export function bindAliasKind(context: TransformContext, aliasName: string, kind: SubjectKind | "intercept"): void {
  context.state.aliasKinds.set(aliasName, kind);
}

export function getBoundSubjectKind(context: TransformContext, identifier: string): SubjectKind | undefined {
  return context.state.bindingKinds.get(identifier);
}

export function getAliasKind(context: TransformContext, aliasName: string): SubjectKind | "intercept" | undefined {
  return context.state.aliasKinds.get(aliasName);
}

export function inferExpressionSubjectKind(expressionText: string, context: TransformContext): SubjectKind {
  const identifierMatch = expressionText.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (identifierMatch) {
    return getBoundSubjectKind(context, identifierMatch[0]) ?? context.hoistedAliases.get(identifierMatch[0]) ?? "value";
  }

  if (
    expressionText.includes(".locator(") ||
    expressionText.includes(".getByText(") ||
    expressionText.includes(".nth(") ||
    expressionText.includes("getLocatorAlias(")
  ) {
    return "locator";
  }

  if (expressionText.includes("waitForAlias(") || expressionText.includes("registerAlias(")) {
    return "response";
  }

  return "value";
}

export function rewriteHoistedAliasReferences(text: string, context: TransformContext): string {
  let rewritten = text;

  for (const aliasName of context.hoistedAliases.keys()) {
    const pattern = new RegExp(`\\bthis\\.${aliasName}\\b`, "g");
    rewritten = rewritten.replace(pattern, aliasName);
  }

  // Phase 3: Rewrite Cypress global API calls
  rewritten = rewriteCypressGlobals(rewritten);

  return rewritten;
}

function normalizeCommentRanges(ranges: CommentRange[] | undefined, sourceText: string): string[] {
  if (!ranges || ranges.length === 0) {
    return [];
  }

  return ranges
    .map((range) => sourceText.slice(range.getPos(), range.getEnd()).trimRight())
    .filter((entry) => entry.trim().length > 0);
}

export function extractCommentTrivia(statement: Statement): CommentIR | undefined {
  const sourceText = statement.getSourceFile().getFullText();
  const leading = normalizeCommentRanges(statement.getLeadingCommentRanges(), sourceText);
  const trailing = normalizeCommentRanges(statement.getTrailingCommentRanges(), sourceText);

  if (leading.length === 0 && trailing.length === 0) {
    return undefined;
  }

  return {
    leading,
    trailing
  };
}
