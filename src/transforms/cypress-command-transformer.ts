import path from "node:path";
import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type IfStatement,
  type ReturnStatement,
  type Statement,
  type VariableDeclaration
} from "ts-morph";
import type { ImportBinding, StatementIR } from "../ir/types";
import type { MigrationIssue, SubjectKind } from "../shared/types";
import type { AnalyzedChainCommand, AnalyzedCommandChain, ChainCallback, LoweredChainResult } from "./control-flow-ir";
import {
  bindAliasKind,
  bindSubjectKind,
  createChildTransformContext,
  createIssue,
  extractCommentTrivia,
  getAliasKind,
  getBoundSubjectKind,
  getHelperImportsNeedingPage,
  getPageObjectClassNames,
  getRequireCall,
  inferExpressionSubjectKind,
  hasIdentifierMutationInScope,
  isExternalModuleSpecifier,
  isJavaScriptSource,
  isMutableArrayLiteral,
  isMutableObjectLiteral,
  needsPageArgumentInjection,
  nextTempVariable,
  renderArguments,
  resolveCommandViaPlugins,
  resolveExplicitAnyType,
  resolveModuleImportSpecifier,
  resolveRuntimeRecipeViaPlugins,
  rewriteNewExpressionIfNeeded,
  rewriteHoistedAliasReferences,
  type TransformContext
} from "./transform-utils";

export type { TransformContext } from "./transform-utils";
export { createIssue, getHelperImportsNeedingPage, getPageObjectClassNames } from "./transform-utils";

function createStatement(
  code: string,
  issues: MigrationIssue[] = [],
  unresolved = false,
  imports: ImportBinding[] = [],
  comments?: StatementIR["comments"]
): StatementIR {
  return {
    code,
    issues,
    unresolved,
    imports,
    comments
  };
}

function inlineStatementText(statement: StatementIR): string {
  const parts: string[] = [];
  if (statement.comments?.leading.length) {
    parts.push(...statement.comments.leading);
  }
  parts.push(statement.code);
  if (statement.comments?.trailing.length) {
    parts.push(...statement.comments.trailing);
  }
  return parts.join("\n");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function createImportBinding(moduleSpecifier: string, namedImport?: string, defaultImport?: string): ImportBinding {
  return {
    moduleSpecifier,
    defaultImport,
    namedImports: namedImport ? [namedImport] : []
  };
}

function createTypedAssignment(
  keyword: "const" | "let",
  identifier: string,
  expression: string,
  context: TransformContext,
  subjectKind: SubjectKind = "value"
): string {
  if (isJavaScriptSource(context) && (subjectKind === "value" || subjectKind === "response" || subjectKind === "unknown")) {
    return `${keyword} ${identifier}: any = ${expression};`;
  }

  return `${keyword} ${identifier} = ${expression};`;
}

function unresolvedStatement(statement: Statement, context: TransformContext, message: string): StatementIR {
  const issue = createIssue(
    statement,
    context.sourceFile.getFilePath(),
    "manual-review",
    message,
    "warning",
    "callback-chain",
    "manual_review"
  );
  const marker = context.runtime.config.reporting.inlineTodoPrefix;
  const original = statement
    .getText()
    .split("\n")
    .map((line) => `// ${line}`)
    .join("\n");

  return createStatement(`// ${marker}: ${message}\n${original}`, [issue], true);
}

function unresolvedExpression(node: Node, context: TransformContext, message: string): StatementIR {
  const issue = createIssue(
    node,
    context.sourceFile.getFilePath(),
    "manual-review",
    message,
    "warning",
    "callback-chain",
    "manual_review"
  );
  const marker = context.runtime.config.reporting.inlineTodoPrefix;

  return createStatement(
    `// ${marker}: ${message}\nthrow new Error(${JSON.stringify(`${marker}: ${message}`)});`,
    [issue],
    true
  );
}

function getCallbackArg(callExpression: CallExpression): ChainCallback | undefined {
  const lastArg = callExpression.getArguments()[callExpression.getArguments().length - 1];
  if (!lastArg || !Node.isArrowFunction(lastArg) && !Node.isFunctionExpression(lastArg)) {
    return undefined;
  }

  return {
    node: lastArg,
    parameterNames: lastArg.getParameters().map((parameter) => parameter.getName())
  };
}

function tryParseCypressChain(expression: Expression): Array<{ name: string; call: CallExpression }> | undefined {
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

function analyzeCommandChain(expression: Expression, context: TransformContext): AnalyzedCommandChain | undefined {
  const links = Node.isCallExpression(expression) ? tryParseCypressChain(expression) : undefined;
  if (!links || links.length === 0) {
    return undefined;
  }

  const commands: AnalyzedChainCommand[] = links.map((link) => {
    let kind: AnalyzedChainCommand["kind"] = "custom";
    if (["get", "find", "contains", "first", "last", "eq", "parent", "children", "siblings", "next", "prev", "closest", "filter"].includes(link.name)) {
      kind = "query";
    } else if (["click", "type", "select", "check", "uncheck", "clear", "dblclick", "rightclick", "focus", "blur", "hover", "scrollIntoView", "scrollTo", "trigger"].includes(link.name)) {
      kind = "action";
    } else if (link.name === "should" || link.name === "and") {
      kind = "assertion";
    } else if (link.name === "as") {
      kind = "alias";
    } else if (["then", "within", "each"].includes(link.name)) {
      kind = "control";
    } else if (["intercept", "wait", "request"].includes(link.name)) {
      kind = "network";
    } else if (["fixture", "task", "visit", "wrap", "window", "url", "location", "title", "focused", "reload", "go", "viewport", "clock", "tick", "log", "screenshot", "clearCookies", "clearLocalStorage", "session", "origin"].includes(link.name)) {
      kind = "value";
    } else if (["invoke", "its"].includes(link.name)) {
      kind = "value";
    }

    return {
      name: link.name,
      call: link.call,
      args: renderArguments(link.call).map((argument) => rewriteSourceText(argument, context)),
      kind,
      callback: getCallbackArg(link.call)
    };
  });

  return { commands };
}

function mergeStrategy(current: LoweredChainResult["conversionStrategy"], next: LoweredChainResult["conversionStrategy"]): LoweredChainResult["conversionStrategy"] {
  if (current === "manual_review" || next === "manual_review") {
    return "manual_review";
  }

  if (current === "best_effort" || next === "best_effort") {
    return "best_effort";
  }

  return "direct";
}

function rewriteSourceText(text: string, context: TransformContext): string {
  return rewriteHoistedAliasReferences(text, context);
}

function rewriteSupportedJqueryExpression(expression: Expression, context: TransformContext): string | undefined {
  if (!Node.isCallExpression(expression)) {
    return undefined;
  }

  const callee = expression.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const target = callee.getExpression().getText();
  if (getBoundSubjectKind(context, target) !== "locator") {
    return undefined;
  }

  switch (callee.getName()) {
    case "text":
      return `await ${target}.textContent()`;
    case "attr":
      return `await ${target}.getAttribute(${expression.getArguments()[0]?.getText() ?? `""`})`;
    case "hasClass":
      return `await ${target}.evaluate((element) => element.classList.contains(${expression.getArguments()[0]?.getText() ?? `""`}))`;
    default:
      return undefined;
  }
}

function isSupportedJqueryCall(callExpression: CallExpression, context: TransformContext): boolean {
  return Boolean(rewriteSupportedJqueryExpression(callExpression, context));
}

function isAmbiguousWrappedValue(subjectExpression: string, subjectKind: SubjectKind): boolean {
  if (subjectKind === "locator" || subjectKind === "collection" || subjectKind === "response") {
    return false;
  }

  return /^\$[A-Za-z_$][A-Za-z0-9_$]*$/.test(subjectExpression) || subjectExpression.includes("jQuery") || subjectExpression.includes("HTMLElement");
}

function lowerResult(
  code: string,
  subjectKind: SubjectKind,
  subjectExpression?: string,
  issues: MigrationIssue[] = [],
  unresolved = false,
  imports: ImportBinding[] = [],
  conversionStrategy: LoweredChainResult["conversionStrategy"] = "direct"
): LoweredChainResult {
  return {
    code,
    subjectExpression,
    subjectKind,
    issues,
    unresolved,
    imports,
    conversionStrategy
  };
}

function getStringArg(callExpression: CallExpression, index = 0): string | undefined {
  const argument = callExpression.getArguments()[index];
  if (!argument) {
    return undefined;
  }

  return argument.getText().replace(/^["'`]|["'`]$/g, "");
}

function createManualReviewIssue(
  command: AnalyzedChainCommand,
  context: TransformContext,
  message: string,
  pattern = "callback-chain"
): MigrationIssue {
  return createIssue(
    command.call,
    context.sourceFile.getFilePath(),
    "manual-review",
    message,
    "warning",
    pattern,
    "manual_review"
  );
}

function translateShouldAssertion(subjectExpression: string, args: string[], context: TransformContext, command: AnalyzedChainCommand, subjectKind: SubjectKind = "locator"): LoweredChainResult {
  const [matcher, expected, expected2] = args;
  const normalizedMatcher = matcher?.replace(/["'`]/g, "") ?? "";
  const isValueSubject = subjectKind === "value" || subjectKind === "response";

  switch (normalizedMatcher) {
    case "be.visible":
    case "exist":
      return lowerResult(`await expect(${subjectExpression}).toBeVisible();`, "locator", subjectExpression);
    case "not.exist":
      return lowerResult(`await expect(${subjectExpression}).toHaveCount(0);`, "locator", subjectExpression);
    case "not.be.visible":
    case "be.hidden":
      return lowerResult(`await expect(${subjectExpression}).toBeHidden();`, "locator", subjectExpression);
    case "contain":
    case "contain.text":
      if (isValueSubject) {
        return lowerResult(`expect(${subjectExpression}).toContain(${expected ?? `""`});`, "value", subjectExpression);
      }
      return lowerResult(`await expect(${subjectExpression}).toContainText(${expected ?? `""`});`, "locator", subjectExpression);
    case "not.contain":
    case "not.contain.text":
      if (isValueSubject) {
        return lowerResult(`expect(${subjectExpression}).not.toContain(${expected ?? `""`});`, "value", subjectExpression);
      }
      return lowerResult(`await expect(${subjectExpression}).not.toContainText(${expected ?? `""`});`, "locator", subjectExpression);
    case "have.text":
      return lowerResult(`await expect(${subjectExpression}).toHaveText(${expected ?? `""`});`, "locator", subjectExpression);
    case "not.have.text":
      return lowerResult(`await expect(${subjectExpression}).not.toHaveText(${expected ?? `""`});`, "locator", subjectExpression);
    case "have.value":
      return lowerResult(`await expect(${subjectExpression}).toHaveValue(${expected ?? `""`});`, "locator", subjectExpression);
    case "not.have.value":
      return lowerResult(`await expect(${subjectExpression}).not.toHaveValue(${expected ?? `""`});`, "locator", subjectExpression);
    case "be.disabled":
      return lowerResult(`await expect(${subjectExpression}).toBeDisabled();`, "locator", subjectExpression);
    case "not.be.disabled":
    case "be.enabled":
      return lowerResult(`await expect(${subjectExpression}).toBeEnabled();`, "locator", subjectExpression);
    case "not.be.enabled":
      return lowerResult(`await expect(${subjectExpression}).toBeDisabled();`, "locator", subjectExpression);
    case "be.checked":
      return lowerResult(`await expect(${subjectExpression}).toBeChecked();`, "locator", subjectExpression);
    case "not.be.checked":
      return lowerResult(`await expect(${subjectExpression}).not.toBeChecked();`, "locator", subjectExpression);
    case "be.empty":
      if (isValueSubject) {
        return lowerResult(`expect(${subjectExpression}).toBeFalsy();`, "value", subjectExpression);
      }
      return lowerResult(`await expect(${subjectExpression}).toBeEmpty();`, "locator", subjectExpression);
    case "not.be.empty":
      if (isValueSubject) {
        return lowerResult(`expect(${subjectExpression}).toBeTruthy();`, "value", subjectExpression);
      }
      return lowerResult(`await expect(${subjectExpression}).not.toBeEmpty();`, "locator", subjectExpression);
    case "be.focused":
      return lowerResult(`await expect(${subjectExpression}).toBeFocused();`, "locator", subjectExpression);
    case "not.be.focused":
      return lowerResult(`await expect(${subjectExpression}).not.toBeFocused();`, "locator", subjectExpression);
    case "be.selected":
      return lowerResult(`await expect(${subjectExpression}).toBeChecked();`, "locator", subjectExpression);
    case "have.length":
      return lowerResult(`await expect(${subjectExpression}).toHaveCount(${expected ?? "0"});`, "locator", subjectExpression);
    case "have.length.greaterThan":
    case "have.length.gt": {
      const countVar = nextTempVariable(context, "count");
      return lowerResult(
        `const ${countVar} = await ${subjectExpression}.count();\nexpect(${countVar}).toBeGreaterThan(${expected ?? "0"});`,
        "locator",
        subjectExpression
      );
    }
    case "have.length.lessThan":
    case "have.length.lt": {
      const countVar = nextTempVariable(context, "count");
      return lowerResult(
        `const ${countVar} = await ${subjectExpression}.count();\nexpect(${countVar}).toBeLessThan(${expected ?? "0"});`,
        "locator",
        subjectExpression
      );
    }
    case "have.length.at.least":
    case "have.length.gte": {
      const countVar = nextTempVariable(context, "count");
      return lowerResult(
        `const ${countVar} = await ${subjectExpression}.count();\nexpect(${countVar}).toBeGreaterThanOrEqual(${expected ?? "0"});`,
        "locator",
        subjectExpression
      );
    }
    case "have.attr":
      if (expected2) {
        return lowerResult(`await expect(${subjectExpression}).toHaveAttribute(${expected ?? `""`}, ${expected2});`, "locator", subjectExpression);
      }
      return lowerResult(`await expect(${subjectExpression}).toHaveAttribute(${expected ?? `""`});`, "locator", subjectExpression);
    case "not.have.attr":
      return lowerResult(`await expect(${subjectExpression}).not.toHaveAttribute(${expected ?? `""`});`, "locator", subjectExpression);
    case "have.class":
      return lowerResult(`await expect(${subjectExpression}).toHaveClass(new RegExp(${expected ?? `""`}));`, "locator", subjectExpression);
    case "not.have.class":
      return lowerResult(`await expect(${subjectExpression}).not.toHaveClass(new RegExp(${expected ?? `""`}));`, "locator", subjectExpression);
    case "have.css":
      return lowerResult(`await expect(${subjectExpression}).toHaveCSS(${expected ?? `""`}, ${expected2 ?? `""`});`, "locator", subjectExpression);
    case "have.id":
      return lowerResult(`await expect(${subjectExpression}).toHaveAttribute("id", ${expected ?? `""`});`, "locator", subjectExpression);
    case "have.data": {
      const dataAttr = expected ? expected.replace(/["'`]/g, "") : "";
      return lowerResult(`await expect(${subjectExpression}).toHaveAttribute("data-${dataAttr}", ${expected2 ?? `/.*/`});`, "locator", subjectExpression);
    }
    case "have.prop": {
      const propVar = nextTempVariable(context, "propValue");
      return lowerResult(
        `const ${propVar} = await ${subjectExpression}.evaluate((el) => (el as any)[${expected ?? `""`}]);\nexpect(${propVar}).toBeTruthy();`,
        "value",
        propVar
      );
    }
    case "include":
    case "include.text":
      return lowerResult(`await expect(${subjectExpression}).toContainText(${expected ?? `""`});`, "locator", subjectExpression);
    case "match":
      return lowerResult(`await expect(${subjectExpression}).toHaveText(${expected ?? `/.*/`});`, "locator", subjectExpression);
    case "have.descendants":
      return lowerResult(`await expect(${subjectExpression}.locator(${expected ?? `"*"`})).toHaveCount(await ${subjectExpression}.locator(${expected ?? `"*"`}).count());`, "locator", subjectExpression);
    default: {
      const issue = createIssue(
        command.call,
        context.sourceFile.getFilePath(),
        "assertion-review",
        `Unsupported should() matcher "${normalizedMatcher}" requires manual review.`,
        "warning",
        normalizedMatcher,
        "manual_review"
      );
      const marker = context.runtime.config.reporting.inlineTodoPrefix;
      return lowerResult(
        `// ${marker}: Unsupported should() matcher "${normalizedMatcher}"\nawait expect(${subjectExpression}).toBeVisible();`,
        "locator",
        subjectExpression,
        [issue],
        true,
        [],
        "manual_review"
      );
    }
  }
}

function buildRequestExpression(command: AnalyzedChainCommand, context: TransformContext): string {
  const args = command.call.getArguments();
  const [firstArg, secondArg] = args;

  if (firstArg && Node.isObjectLiteralExpression(firstArg)) {
    const method = firstArg
      .getProperty("method")
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.getText()
      ?.replace(/["'`]/g, "")
      ?.toLowerCase() ?? "get";
    const url =
      firstArg
        .getProperty("url")
        ?.asKind(SyntaxKind.PropertyAssignment)
        ?.getInitializer()
        ?.getText() ?? `"/"`;
    const body = firstArg
      .getProperty("body")
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.getText();
    const bodyPart = body ? `, { data: ${body} }` : "";
    return `${context.requestIdentifier}.${method}(${url}${bodyPart})`;
  }

  if (secondArg) {
    return `${context.requestIdentifier}.request(${firstArg?.getText() ?? `"/"`}, ${secondArg.getText()})`;
  }

  return `${context.requestIdentifier}.get(${firstArg?.getText() ?? `"/"`})`;
}

function buildInterceptMatcher(callExpression: CallExpression): string {
  const args = callExpression.getArguments();
  const [firstArg, secondArg] = args;

  if (args.length >= 2) {
    return `(response.request().method() === ${firstArg.getText()} && response.url().includes(String(${secondArg.getText()})))`;
  }

  if (firstArg && Node.isObjectLiteralExpression(firstArg)) {
    const method =
      firstArg
        .getProperty("method")
        ?.asKind(SyntaxKind.PropertyAssignment)
        ?.getInitializer()
        ?.getText() ?? undefined;
    const url =
      firstArg
        .getProperty("url")
        ?.asKind(SyntaxKind.PropertyAssignment)
        ?.getInitializer()
        ?.getText() ?? undefined;

    if (method && url) {
      return `(response.request().method() === ${method} && response.url().includes(String(${url})))`;
    }
  }

  return `response.url().includes(String(${firstArg?.getText() ?? `"/"`}))`;
}

function callbackHasUnsupportedJqueryUsage(callback: ChainCallback, context: TransformContext): boolean {
  const params = new Set(callback.parameterNames);

  return callback.node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((propertyAccess) => {
    if (!params.has(propertyAccess.getExpression().getText())) {
      return false;
    }

    const parent = propertyAccess.getParentIfKind(SyntaxKind.CallExpression);
    if (!parent) {
      return true;
    }

    return !isSupportedJqueryCall(parent, context);
  });
}

function callbackMutatesOuterState(callback: ChainCallback): boolean {
  const localNames = new Set(callback.parameterNames);
  for (const declaration of callback.node.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    localNames.add(declaration.getName());
  }

  const astMutation = callback.node.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((binaryExpression) => {
    if (binaryExpression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      return false;
    }

    const left = binaryExpression.getLeft();
    return Node.isIdentifier(left) && !localNames.has(left.getText());
  });

  if (astMutation) {
    return true;
  }

  return callback
    .node
    .getBody()
    .getText()
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      if (/^(const|let|var)\s+/.test(trimmed)) {
        return false;
      }

      const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
      return Boolean(match && !localNames.has(match[1]));
    });
}

function lowerCallbackBlock(
  command: AnalyzedChainCommand,
  callback: ChainCallback,
  context: TransformContext,
  bindingStatements: string[],
  allowReturn: boolean
): LoweredChainResult {
  const callbackContext = createChildTransformContext(context, {
    controlFlowDepth: context.controlFlowDepth + 1
  });

  const body = callback.node.getBody();
  if (!Node.isBlock(body)) {
    const issue = createManualReviewIssue(command, context, "Expression-bodied Cypress callbacks require manual review.");
    return lowerResult(
      `// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`,
      "unknown",
      undefined,
      [issue],
      true,
      [],
      "manual_review"
    );
  }

  if (callbackContext.controlFlowDepth > context.runtime.config.reporting.maxBestEffortDepth) {
    const issue = createManualReviewIssue(
      command,
      context,
      `Control-flow depth exceeded maxBestEffortDepth (${context.runtime.config.reporting.maxBestEffortDepth}).`
    );
    return lowerResult(
      `// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`,
      "unknown",
      undefined,
      [issue],
      true,
      [],
      "manual_review"
    );
  }

  if (!allowReturn && body.getDescendantsOfKind(SyntaxKind.ReturnStatement).length > 0) {
    const issue = createManualReviewIssue(command, context, `Control-flow callback "${command.name}" contains return statements that require manual review.`);
    return lowerResult(
      `// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`,
      "unknown",
      undefined,
      [issue],
      true,
      [],
      "manual_review"
    );
  }

  const issues: MigrationIssue[] = [];
  if (callbackHasUnsupportedJqueryUsage(callback, callbackContext)) {
    issues.push(createManualReviewIssue(command, context, `Callback uses jQuery-only access and needs review.`));
  }

  if (callbackMutatesOuterState(callback)) {
    issues.push(createManualReviewIssue(command, context, `Callback mutates outer variables and needs review.`));
  }

  for (const bindingStatement of bindingStatements) {
    const match = bindingStatement.match(/^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?::\s*[^=]+)?\s*=\s*(.+);$/);
    if (match) {
      bindSubjectKind(callbackContext, match[1], inferExpressionSubjectKind(match[2], callbackContext));
    }
  }

  const translatedStatements = body.getStatements().flatMap((statement) => translateStatements(statement, callbackContext));
  const imports = translatedStatements.flatMap((statement) => statement.imports ?? []);
  const translatedIssues = translatedStatements.flatMap((statement) => statement.issues);
  const hasReturn = body.getDescendantsOfKind(SyntaxKind.ReturnStatement).length > 0;
  let subjectKind: SubjectKind = "unknown";

  if (hasReturn) {
    const returnStatement = body.getDescendantsOfKind(SyntaxKind.ReturnStatement).at(-1);
    const expression = returnStatement?.getExpression();
    if (expression) {
      subjectKind = inferExpressionSubjectKind(expression.getText(), callbackContext);
    }
  }

  const reviewPrefix =
    issues.length > 0 || context.runtime.config.reporting.strictControlFlow
      ? [`// ${context.runtime.config.reporting.inlineTodoPrefix}: review ${command.name} callback semantics`]
      : [];

  return lowerResult(
    [...bindingStatements, ...reviewPrefix, ...translatedStatements.map((statement) => inlineStatementText(statement))].join("\n"),
    subjectKind,
    undefined,
    [...issues, ...translatedIssues],
    translatedStatements.some((statement) => statement.unresolved) || issues.length > 0 || context.runtime.config.reporting.strictControlFlow,
    imports,
    issues.length > 0 || context.runtime.config.reporting.strictControlFlow ? "best_effort" : "direct"
  );
}

function lowerRootCommand(command: AnalyzedChainCommand, context: TransformContext): LoweredChainResult {
  switch (command.name) {
    case "visit":
      return lowerResult(`await ${context.pageIdentifier}.goto(${command.args[0] ?? `"/"`});`, "unknown");
    case "get": {
      const argValue = getStringArg(command.call);
      if (argValue?.startsWith("@")) {
        const aliasName = argValue.slice(1);
        const hoistedAliasKind = context.hoistedAliases.get(aliasName);
        if (hoistedAliasKind) {
          return lowerResult("", hoistedAliasKind, aliasName);
        }

        const aliasKind = getAliasKind(context, aliasName) ?? "value";
        if (aliasKind === "locator") {
          return lowerResult("", "locator", `getLocatorAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)})`);
        }

        if (aliasKind === "intercept") {
          return lowerResult("", "response", `await waitForAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)})`);
        }

        return lowerResult("", "value", `await getValueAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)})`);
      }

      // Phase 3: Upgrade [data-testid="x"] to getByTestId("x")
      const testIdMatch = argValue?.match(/^\[data-testid=["'](.+?)["']\]$/);
      if (testIdMatch) {
        return lowerResult("", "locator", `${context.pageIdentifier}.getByTestId(${JSON.stringify(testIdMatch[1])})`);
      }

      return lowerResult("", "locator", `${context.pageIdentifier}.locator(${command.args[0] ?? `""`})`);
    }
    case "contains":
      return lowerResult("", "locator", `${context.pageIdentifier}.getByText(${command.args[0] ?? `""`})`);
    case "fixture":
      return lowerResult("", "value", `await ${context.loadFixtureIdentifier}(${command.args.join(", ")})`);
    case "request":
      return lowerResult(
        "",
        "value",
        `await normalizeResponse(await ${buildRequestExpression(command, context)})`,
        [],
        false,
        [],
        "best_effort"
      );
    case "window":
      return lowerResult("", "value", "window");
    case "task": {
      const taskName = getStringArg(command.call);
      const issues: MigrationIssue[] = [];
      if (taskName && !context.runtime.config.taskMap[taskName]) {
        issues.push(
          createIssue(
            command.call,
            context.sourceFile.getFilePath(),
            "task-runtime",
            `Task "${taskName}" will use runtime fallback until taskMap is configured.`,
            "warning",
            "alias-value-flow",
            "best_effort"
          )
        );
      }

      return lowerResult(
        "",
        "value",
        `await ${context.runTaskIdentifier}(${command.args.join(", ")})`,
        issues,
        issues.length > 0,
        [],
        issues.length > 0 ? "best_effort" : "direct"
      );
    }
    case "wrap": {
      const subjectExpression = command.args[0] ?? "undefined";
      const subjectKind = inferExpressionSubjectKind(subjectExpression, context);
      if (isAmbiguousWrappedValue(subjectExpression, subjectKind)) {
        const issue = createIssue(
          command.call,
          context.sourceFile.getFilePath(),
          "wrap-review",
          `cy.wrap(${subjectExpression}) is ambiguous DOM/jQuery state and requires manual review.`,
          "warning",
          "alias-value-flow",
          "manual_review"
        );
        return lowerResult(
          `// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`,
          "unknown",
          subjectExpression,
          [issue],
          true,
          [],
          "manual_review"
        );
      }

      return lowerResult("", subjectKind, subjectExpression);
    }
    case "intercept": {
      // Phase 2: Detect response stubbing patterns
      const interceptCallArgs = command.call.getArguments();
      const lastInterceptArg = interceptCallArgs[interceptCallArgs.length - 1];
      if (lastInterceptArg && Node.isObjectLiteralExpression(lastInterceptArg)) {
        const hasResponseProps = lastInterceptArg.getProperties().some((prop) => {
          if (!Node.isPropertyAssignment(prop)) return false;
          return ["body", "fixture", "statusCode", "headers", "forceNetworkError"].includes(prop.getName());
        });
        if (hasResponseProps) {
          const urlArg = interceptCallArgs.length >= 3 ? interceptCallArgs[1]?.getText() : interceptCallArgs[0]?.getText();
          const urlValue = urlArg?.replace(/["'`]/g, "") ?? "/";
          const bodyProp = lastInterceptArg.getProperty("body")?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()?.getText();
          const statusProp = lastInterceptArg.getProperty("statusCode")?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()?.getText();
          const fixtureProp = lastInterceptArg.getProperty("fixture")?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()?.getText();
          const fulfillParts: string[] = [];
          if (statusProp) fulfillParts.push(`status: ${statusProp}`);
          if (bodyProp) fulfillParts.push(`body: JSON.stringify(${bodyProp})`);
          if (fixtureProp) fulfillParts.push(`body: JSON.stringify(await ${context.loadFixtureIdentifier}(${fixtureProp}))`);
          fulfillParts.push(`contentType: "application/json"`);
          return lowerResult(
            `await ${context.pageIdentifier}.route(${JSON.stringify("**" + urlValue)}, async (route) => {\n  await route.fulfill({ ${fulfillParts.join(", ")} });\n});`,
            "response",
            undefined,
            [],
            false,
            [],
            "best_effort"
          );
        }
      }
      return lowerResult("", "response");
    }
    case "url":
      return lowerResult("", "value", `${context.pageIdentifier}.url()`);
    case "location":
      return lowerResult("", "value", `new URL(${context.pageIdentifier}.url())`);
    case "title":
      return lowerResult("", "value", `await ${context.pageIdentifier}.title()`);
    case "focused":
      return lowerResult("", "locator", `${context.pageIdentifier}.locator(":focus")`);
    case "reload":
      return lowerResult(`await ${context.pageIdentifier}.reload();`, "unknown");
    case "go": {
      const direction = getStringArg(command.call);
      if (direction === "forward") {
        return lowerResult(`await ${context.pageIdentifier}.goForward();`, "unknown");
      }
      return lowerResult(`await ${context.pageIdentifier}.goBack();`, "unknown");
    }
    case "viewport": {
      const vpWidth = command.args[0] ?? "1280";
      const vpHeight = command.args[1] ?? "720";
      return lowerResult(`await ${context.pageIdentifier}.setViewportSize({ width: ${vpWidth}, height: ${vpHeight} });`, "unknown");
    }
    case "clearCookies":
      return lowerResult(`await ${context.pageIdentifier}.context().clearCookies();`, "unknown");
    case "clearLocalStorage":
      return lowerResult(`await ${context.pageIdentifier}.evaluate(() => localStorage.clear());`, "unknown");
    case "log":
      return lowerResult(`console.log(${command.args.join(", ")});`, "unknown");
    case "screenshot":
      return lowerResult(`await ${context.pageIdentifier}.screenshot({ path: ${command.args[0] ?? `"screenshot.png"`} });`, "unknown");
    case "clock":
      return lowerResult(`await ${context.pageIdentifier}.clock.install();`, "unknown");
    case "tick":
      return lowerResult(`await ${context.pageIdentifier}.clock.fastForward(${command.args[0] ?? "0"});`, "unknown");
    case "session": {
      const sessionName = command.args[0] ?? `"default"`;
      const sessionSetupCallback = command.callback;
      const sessionIssue = createManualReviewIssue(command, context, `cy.session(${sessionName}) converted to Playwright storageState pattern — review auth setup.`, "session-setup");
      if (sessionSetupCallback) {
        const sessionLowered = lowerCallbackBlock(command, sessionSetupCallback, context, [], false);
        return lowerResult(
          `// Playwright storageState auth for session ${sessionName}\n${sessionLowered.code}\nawait ${context.pageIdentifier}.context().storageState({ path: \`.auth/\${${sessionName}}.json\` });`,
          "unknown",
          undefined,
          [sessionIssue, ...sessionLowered.issues],
          true,
          sessionLowered.imports,
          "best_effort"
        );
      }
      return lowerResult(
        `await ${context.pageIdentifier}.context().storageState({ path: \`.auth/\${${sessionName}}.json\` });`,
        "unknown",
        undefined,
        [sessionIssue],
        true,
        [],
        "best_effort"
      );
    }
    case "origin": {
      // Playwright has no same-origin restriction
      const originCallback = command.callback;
      if (originCallback) {
        const originLowered = lowerCallbackBlock(command, originCallback, context, [], false);
        return lowerResult(
          `// Playwright has no same-origin restriction — executing cross-origin block directly\nawait ${context.pageIdentifier}.goto(${command.args[0] ?? `"/"`});\n${originLowered.code}`,
          "unknown",
          undefined,
          originLowered.issues,
          originLowered.unresolved,
          originLowered.imports,
          "best_effort"
        );
      }
      return lowerResult(`await ${context.pageIdentifier}.goto(${command.args[0] ?? `"/"`});`, "unknown");
    }
    default:
      return lowerResult("", "unknown");
  }
}

function lowerCustomCommand(command: AnalyzedChainCommand, context: TransformContext, asExpression: boolean): LoweredChainResult {
  const pluginResult = resolveCommandViaPlugins(context, command.call, command.name, command.args);
  if (pluginResult) {
    const imports = (pluginResult.imports ?? []).map((entry) => ({
      moduleSpecifier: entry.moduleSpecifier,
      namedImports: [entry.namedImport]
    }));
    const code = pluginResult.code.replace(/;$/, "");
    return lowerResult(
      asExpression ? code.replace(/^await\s+/, "") : `${code};`,
      "unknown",
      asExpression ? code.replace(/^await\s+/, "") : undefined,
      pluginResult.issues ?? [],
      Boolean(pluginResult.issues?.length),
      imports,
      "best_effort"
    );
  }

  const mapping = context.runtime.config.customCommandMap[command.name];
  if (!mapping) {
    const issue = createManualReviewIssue(command, context, `Custom command "${command.name}" is not mapped in config or plugin hooks.`);
    return lowerResult(
      `// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}\nthrow new Error(${JSON.stringify(issue.message)});`,
      "unknown",
      undefined,
      [issue],
      true,
      [],
      "manual_review"
    );
  }

  const invocationArgs = mapping.includePageArgument === false
    ? command.args
    : [context.pageIdentifier, ...command.args];
  const code = `${mapping.isAsync === false ? "" : "await "}${mapping.target}(${invocationArgs.join(", ")})`;
  const imports = mapping.importPath ? [{ moduleSpecifier: mapping.importPath, namedImports: [mapping.target] }] : [];
  return lowerResult(
    asExpression ? code.replace(/^await\s+/, "") : `${code};`,
    "unknown",
    asExpression ? code.replace(/^await\s+/, "") : undefined,
    [],
    false,
    imports
  );
}

function lowerSpreadJsWindowRecipe(
  callback: ChainCallback,
  context: TransformContext
): LoweredChainResult | undefined {
  const body = callback.node.getBody();
  if (!Node.isBlock(body)) {
    return undefined;
  }

  const statements = body.getStatements();
  const finalStatement = statements.at(-1);
  if (!finalStatement || !Node.isExpressionStatement(finalStatement)) {
    return undefined;
  }

  const matcher = getExpectMatcherChain(finalStatement.getExpression());
  const actualArg = matcher?.expectCall.getArguments()[0];
  if (!matcher || !actualArg || !Node.isIdentifier(actualArg) || !["eq", "equal"].includes(matcher.matcherName)) {
    return undefined;
  }

  const runtimeStatements = statements.slice(0, -1);
  if (runtimeStatements.length === 0) {
    return undefined;
  }

  const runtimeSource = runtimeStatements.map((statement) => statement.getText()).join("\n");
  if (!runtimeSource.includes(".GC.Spread.Sheets.findControl")) {
    return undefined;
  }

  const windowIdentifier = callback.parameterNames[0] || "appWindow";
  const pluginRecipe = resolveRuntimeRecipeViaPlugins(context, callback.node, windowIdentifier);
  if (pluginRecipe) {
    const imports = (pluginRecipe.imports ?? []).map((entry) => ({
      moduleSpecifier: entry.moduleSpecifier,
      namedImports: [entry.namedImport]
    }));
    return lowerResult(
      pluginRecipe.code,
      "value",
      undefined,
      pluginRecipe.issues ?? [],
      Boolean(pluginRecipe.issues?.length),
      imports,
      "best_effort"
    );
  }

  const evaluateResult = nextTempVariable(context, "runtimeValue");
  const evaluateLines = runtimeStatements.flatMap((statement) => {
    if (Node.isVariableStatement(statement)) {
      return statement.getDeclarations().map((declaration) => {
        const initializer = declaration.getInitializer();
        const rewrittenInitializer = initializer ? rewriteExpression(initializer, context) : "undefined";
        return createTypedAssignment(
          statement.getDeclarationKind() === "const" ? "const" : "let",
          declaration.getName(),
          rewrittenInitializer,
          context,
          "value"
        );
      });
    }

    if (Node.isExpressionStatement(statement)) {
      return [`${rewriteExpression(statement.getExpression(), context)};`];
    }

    return [statement.getText()];
  });

  const expectedText = matcher.expectedArg ? rewriteExpression(matcher.expectedArg, context) : `undefined`;
  const infoIssue = createIssue(
    callback.node,
    context.sourceFile.getFilePath(),
    "runtime-recipe",
    "SpreadJS-style window callback lowered through a serializable page.evaluate recipe.",
    "info",
    "runtime-recipe",
    "best_effort"
  );

  return lowerResult(
    [
      `const ${evaluateResult}: any = await ${context.pageIdentifier}.evaluate(() => {`,
      `  const ${windowIdentifier}: any = window as any;`,
      ...evaluateLines.map((line) => `  ${line}`),
      `  return ${actualArg.getText()};`,
      `});`,
      `expect(${evaluateResult}).toBe(${expectedText});`
    ].join("\n"),
    "value",
    evaluateResult,
    [infoIssue],
    false,
    [],
    "best_effort"
  );
}

function lowerCommandChain(analyzedChain: AnalyzedCommandChain, context: TransformContext, asExpression = false): LoweredChainResult {
  const [rootCommand, ...rest] = analyzedChain.commands;
  if (!rootCommand) {
    return lowerResult("", "unknown");
  }

  if (rootCommand.kind === "custom") {
    return lowerCustomCommand(rootCommand, context, asExpression);
  }

  if (rootCommand.name === "window" && rest.length === 1 && rest[0]?.name === "then" && rest[0].callback) {
    const runtimeRecipe = lowerSpreadJsWindowRecipe(rest[0].callback, context);
    if (runtimeRecipe) {
      return runtimeRecipe;
    }
  }

  const issues: MigrationIssue[] = [];
  const imports: ImportBinding[] = [];
  const codeLines: string[] = [];
  let current = lowerRootCommand(rootCommand, context);
  let unresolved = current.unresolved;
  let strategy = current.conversionStrategy;

  issues.push(...current.issues);
  imports.push(...current.imports);
  if (current.code) {
    codeLines.push(current.code);
  }

  for (const command of rest) {
    switch (command.name) {
      case "find":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator(${command.args[0] ?? `""`})`);
        break;
      case "contains":
        current = lowerResult("", "locator", `${current.subjectExpression}.getByText(${command.args[0] ?? `""`})`);
        break;
      case "click":
        codeLines.push(`await ${current.subjectExpression}.click();`);
        break;
      case "type":
        codeLines.push(`await ${current.subjectExpression}.fill(${command.args[0] ?? `""`});`);
        break;
      case "select":
        codeLines.push(`await ${current.subjectExpression}.selectOption(${command.args[0] ?? `""`});`);
        break;
      case "check":
        codeLines.push(`await ${current.subjectExpression}.check();`);
        break;
      case "uncheck":
        codeLines.push(`await ${current.subjectExpression}.uncheck();`);
        break;
      case "and":
      case "should": {
        const assertion = translateShouldAssertion(current.subjectExpression ?? context.pageIdentifier, command.args, context, command, current.subjectKind);
        codeLines.push(assertion.code);
        issues.push(...assertion.issues);
        imports.push(...assertion.imports);
        unresolved = unresolved || assertion.unresolved;
        strategy = mergeStrategy(strategy, assertion.conversionStrategy);
        break;
      }
      case "as": {
        const aliasName = getStringArg(command.call);
        if (!aliasName) {
          break;
        }

        const hoistedAliasKind = context.hoistedAliases.get(aliasName);
        if (hoistedAliasKind) {
          bindAliasKind(context, aliasName, hoistedAliasKind);
          codeLines.push(`${aliasName} = ${current.subjectExpression};`);
          current = lowerResult("", hoistedAliasKind, aliasName);
          strategy = "best_effort";
          break;
        }

        if (rootCommand.name === "intercept") {
          bindAliasKind(context, aliasName, "intercept");
          codeLines.push(
            `registerAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)}, ${context.pageIdentifier}.waitForResponse((response) => ${buildInterceptMatcher(rootCommand.call)}));`
          );
          current = lowerResult("", "response", `await waitForAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)})`);
          break;
        }

        if (current.subjectKind === "locator" || current.subjectKind === "collection") {
          bindAliasKind(context, aliasName, "locator");
          codeLines.push(`registerLocatorAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)}, ${current.subjectExpression});`);
        } else {
          bindAliasKind(context, aliasName, "value");
          const valueVar = nextTempVariable(context, "aliasedValue");
          codeLines.push(createTypedAssignment("const", valueVar, current.subjectExpression ?? "undefined", context, "value"));
          codeLines.push(`registerValueAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)}, ${valueVar});`);
          current = lowerResult("", "value", valueVar);
        }
        break;
      }
      case "wait": {
        const firstArg = command.call.getArguments()[0];
        if (!firstArg) {
          const issue = createManualReviewIssue(command, context, "cy.wait() without argument is unsupported.", "alias-value-flow");
          issues.push(issue);
          unresolved = true;
          strategy = "manual_review";
          codeLines.push(`// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`);
          break;
        }

        if (Node.isNumericLiteral(firstArg)) {
          codeLines.push(`await ${context.pageIdentifier}.waitForTimeout(${firstArg.getText()});`);
          current = lowerResult("", "unknown");
        } else {
          const aliasName = firstArg.getText().replace(/["'`@]/g, "");
          current = lowerResult("", "response", `await waitForAlias(${context.migrationStateIdentifier}, ${JSON.stringify(aliasName)})`);
          codeLines.push(`${current.subjectExpression};`);
        }
        break;
      }
      case "within": {
        const callback = command.callback;
        if (!callback || !current.subjectExpression) {
          const issue = createManualReviewIssue(command, context, "cy.within() requires a scoped locator subject.", "scoped-locator");
          issues.push(issue);
          unresolved = true;
          strategy = "manual_review";
          codeLines.push(`// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`);
          break;
        }

        const scopeVar = nextTempVariable(context, "scopeLocator");
        const bindingStatements = [createTypedAssignment("const", scopeVar, current.subjectExpression ?? "undefined", context, "locator")];
        if (callback.parameterNames[0]) {
          bindingStatements.push(createTypedAssignment("const", callback.parameterNames[0], scopeVar, context, "locator"));
        }
        const lowered = lowerCallbackBlock(command, callback, createChildTransformContext(context, { pageIdentifier: scopeVar }), bindingStatements, false);
        codeLines.push(lowered.code);
        issues.push(...lowered.issues);
        imports.push(...lowered.imports);
        unresolved = unresolved || lowered.unresolved;
        strategy = mergeStrategy(strategy, lowered.conversionStrategy === "direct" ? "best_effort" : lowered.conversionStrategy);
        current = lowerResult("", "locator", scopeVar);
        break;
      }
      case "each": {
        const callback = command.callback;
        if (!callback || !current.subjectExpression) {
          const issue = createManualReviewIssue(command, context, "cy.each() requires a collection subject.", "collection-iteration");
          issues.push(issue);
          unresolved = true;
          strategy = "manual_review";
          codeLines.push(`// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`);
          break;
        }

        const collectionVar = nextTempVariable(context, "collection");
        const countVar = nextTempVariable(context, "collectionCount");
        const itemVar = callback.parameterNames[0] || nextTempVariable(context, "item");
        const indexVar = callback.parameterNames[1] || nextTempVariable(context, "index");
        const childContext = createChildTransformContext(context);
        bindSubjectKind(childContext, itemVar, "locator");
        bindSubjectKind(childContext, indexVar, "value");
        const lowered = lowerCallbackBlock(
          command,
          callback,
          childContext,
          [createTypedAssignment("const", itemVar, `${collectionVar}.nth(${indexVar})`, context, "locator")],
          false
        );
        codeLines.push(createTypedAssignment("const", collectionVar, current.subjectExpression ?? "undefined", context, "collection"));
        codeLines.push(`const ${countVar} = await ${collectionVar}.count();`);
        codeLines.push(`for (let ${indexVar} = 0; ${indexVar} < ${countVar}; ${indexVar} += 1) {`);
        codeLines.push(lowered.code.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n"));
        codeLines.push(`}`);
        issues.push(...lowered.issues);
        imports.push(...lowered.imports);
        unresolved = unresolved || lowered.unresolved;
        strategy = "best_effort";
        current = lowerResult("", "collection", collectionVar);
        break;
      }
      case "then": {
        const callback = command.callback;
        if (!callback || !current.subjectExpression) {
          const issue = createManualReviewIssue(command, context, "cy.then() requires a prior subject.");
          issues.push(issue);
          unresolved = true;
          strategy = "manual_review";
          codeLines.push(`// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`);
          break;
        }

        const subjectVar = nextTempVariable(context, "thenSubject");
        const bindings = [createTypedAssignment("const", subjectVar, current.subjectExpression ?? "undefined", context, current.subjectKind)];
        if (callback.parameterNames[0]) {
          bindings.push(createTypedAssignment("const", callback.parameterNames[0], subjectVar, context, current.subjectKind));
        }
        const childContext = createChildTransformContext(context);
        bindSubjectKind(childContext, subjectVar, current.subjectKind);
        if (callback.parameterNames[0]) {
          bindSubjectKind(childContext, callback.parameterNames[0], current.subjectKind);
        }
        const lowered = lowerCallbackBlock(command, callback, childContext, bindings, true);
        const hasReturn = callback.node.getBody().getDescendantsOfKind?.(SyntaxKind.ReturnStatement)?.length > 0;
        if (hasReturn) {
          const resultVar = nextTempVariable(context, "thenResult");
          codeLines.push(`${isJavaScriptSource(context) ? `const ${resultVar}: any` : `const ${resultVar}`} = await (async () => {\n${lowered.code.split("\n").map((line) => `  ${line}`).join("\n")}\n})();`);
          current = lowerResult("", lowered.subjectKind || "value", resultVar);
        } else {
          codeLines.push(`await (async () => {\n${lowered.code.split("\n").map((line) => `  ${line}`).join("\n")}\n})();`);
          current = lowerResult("", current.subjectKind, subjectVar);
        }
        issues.push(...lowered.issues);
        imports.push(...lowered.imports);
        unresolved = unresolved || lowered.unresolved;
        strategy = "best_effort";
        break;
      }
      case "clear":
        codeLines.push(`await ${current.subjectExpression}.clear();`);
        break;
      case "dblclick":
        codeLines.push(`await ${current.subjectExpression}.dblclick();`);
        break;
      case "rightclick":
        codeLines.push(`await ${current.subjectExpression}.click({ button: "right" });`);
        break;
      case "focus":
        codeLines.push(`await ${current.subjectExpression}.focus();`);
        break;
      case "blur":
        codeLines.push(`await ${current.subjectExpression}.blur();`);
        break;
      case "hover":
        codeLines.push(`await ${current.subjectExpression}.hover();`);
        break;
      case "scrollIntoView":
        codeLines.push(`await ${current.subjectExpression}.scrollIntoViewIfNeeded();`);
        break;
      case "scrollTo":
        codeLines.push(`await ${context.pageIdentifier}.evaluate((x, y) => window.scrollTo(x, y), ${command.args[0] ?? "0"}, ${command.args[1] ?? "0"});`);
        break;
      case "trigger": {
        const eventName = command.args[0]?.replace(/["'`]/g, "") ?? "click";
        codeLines.push(`await ${current.subjectExpression}.dispatchEvent(${JSON.stringify(eventName)});`);
        break;
      }
      case "first":
        current = lowerResult("", "locator", `${current.subjectExpression}.first()`);
        break;
      case "last":
        current = lowerResult("", "locator", `${current.subjectExpression}.last()`);
        break;
      case "eq":
        current = lowerResult("", "locator", `${current.subjectExpression}.nth(${command.args[0] ?? "0"})`);
        break;
      case "parent":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator("..")`);
        break;
      case "children":
        current = lowerResult("", "locator", command.args[0]
          ? `${current.subjectExpression}.locator(">").filter({ has: ${context.pageIdentifier}.locator(${command.args[0]}) })`
          : `${current.subjectExpression}.locator("> *")`);
        break;
      case "siblings":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator(".. > *").filter({ hasNot: ${current.subjectExpression} })`);
        break;
      case "next":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator("xpath=following-sibling::*[1]")`);
        break;
      case "prev":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator("xpath=preceding-sibling::*[1]")`);
        break;
      case "closest":
        current = lowerResult("", "locator", `${current.subjectExpression}.locator(${command.args[0] ?? `"*"`}).first()`);
        break;
      case "filter":
        current = lowerResult("", "locator", command.args[0]
          ? `${current.subjectExpression}.filter({ has: ${context.pageIdentifier}.locator(${command.args[0]}) })`
          : current.subjectExpression ?? "");
        break;
      case "invoke": {
        const invokeMethod = command.args[0]?.replace(/["'`]/g, "") ?? "";
        if (invokeMethod === "text") {
          current = lowerResult("", "value", `await ${current.subjectExpression}.textContent()`);
        } else if (invokeMethod === "val") {
          current = lowerResult("", "value", `await ${current.subjectExpression}.inputValue()`);
        } else if (invokeMethod === "attr") {
          current = lowerResult("", "value", `await ${current.subjectExpression}.getAttribute(${command.args[1] ?? `""`})`);
        } else if (invokeMethod === "prop") {
          current = lowerResult("", "value", `await ${current.subjectExpression}.evaluate((el) => (el as any)[${command.args[1] ?? `""`}])`);
        } else if (invokeMethod === "css") {
          current = lowerResult("", "value", `await ${current.subjectExpression}.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), ${command.args[1] ?? `""`})`);
        } else if (invokeMethod === "show" || invokeMethod === "hide" || invokeMethod === "toggle") {
          codeLines.push(`await ${current.subjectExpression}.evaluate((el) => { (el as HTMLElement).style.display = ${invokeMethod === "hide" ? `"none"` : `""`}; });`);
        } else if (invokeMethod === "removeAttr") {
          codeLines.push(`await ${current.subjectExpression}.evaluate((el, attr) => el.removeAttribute(attr), ${command.args[1] ?? `""`});`);
        } else {
          const invokeVar = nextTempVariable(context, "invokeResult");
          codeLines.push(createTypedAssignment("const", invokeVar, `await ${current.subjectExpression}.evaluate((el) => (el as any).${invokeMethod}())`, context, "value"));
          current = lowerResult("", "value", invokeVar);
        }
        break;
      }
      case "its": {
        const itsProperty = command.args[0]?.replace(/["'`]/g, "") ?? "";
        if (current.subjectKind === "response" || current.subjectKind === "value") {
          const itsParts = itsProperty.split(".");
          current = lowerResult("", "value", `(${current.subjectExpression})${itsParts.map((p) => `.${p}`).join("")}`);
        } else {
          const itsVar = nextTempVariable(context, "propertyValue");
          codeLines.push(createTypedAssignment("const", itsVar, `await ${current.subjectExpression}.evaluate((el) => (el as any).${itsProperty})`, context, "value"));
          current = lowerResult("", "value", itsVar);
        }
        break;
      }
      default: {
        const custom = lowerCustomCommand(command, context, false);
        codeLines.push(custom.code);
        issues.push(...custom.issues);
        imports.push(...custom.imports);
        unresolved = unresolved || custom.unresolved;
        strategy = mergeStrategy(strategy, custom.conversionStrategy);
      }
    }
  }

  if (asExpression && current.subjectExpression && codeLines.length === 0) {
    return lowerResult(current.subjectExpression, current.subjectKind, current.subjectExpression, issues, unresolved, imports, strategy);
  }

  if (!asExpression && codeLines.length === 0 && current.subjectExpression) {
    return lowerResult(`${current.subjectExpression};`, current.subjectKind, current.subjectExpression, issues, unresolved, imports, strategy);
  }

  return lowerResult(codeLines.join("\n"), current.subjectKind, current.subjectExpression, issues, unresolved, imports, strategy);
}

function getExpectMatcherChain(expression: Expression): {
  expectCall: CallExpression;
  matcherName: string;
  expectedArg?: Expression;
} | undefined {
  if (!Node.isCallExpression(expression)) {
    return undefined;
  }

  const matcherAccess = expression.getExpression();
  if (!Node.isPropertyAccessExpression(matcherAccess)) {
    return undefined;
  }

  const matcherName = matcherAccess.getName();
  const matcherTarget = matcherAccess.getExpression();
  let expectCall: CallExpression | undefined;
  if (Node.isCallExpression(matcherTarget)) {
    expectCall = matcherTarget;
  } else if (Node.isPropertyAccessExpression(matcherTarget)) {
    const nestedExpression = matcherTarget.getExpression();
    if (Node.isCallExpression(nestedExpression)) {
      expectCall = nestedExpression;
    }
  }

  if (!expectCall || expectCall.getExpression().getText() !== "expect") {
    return undefined;
  }

  const expectedArgCandidate = expression.getArguments()[0];
  return {
    expectCall,
    matcherName,
    expectedArg: expectedArgCandidate && Node.isExpression(expectedArgCandidate)
      ? expectedArgCandidate
      : undefined
  };
}

function translateJqueryExpectationStatement(statement: Statement, context: TransformContext): StatementIR | undefined {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }

  const matcherChain = getExpectMatcherChain(statement.getExpression());
  if (!matcherChain) {
    return undefined;
  }

  const actualArg = matcherChain.expectCall.getArguments()[0];
  if (!actualArg || !Node.isCallExpression(actualArg)) {
    return undefined;
  }

  const callee = actualArg.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const locatorName = callee.getExpression().getText();
  if (getBoundSubjectKind(context, locatorName) !== "locator") {
    return undefined;
  }

  const matcherName = matcherChain.matcherName;
  const expectedText = matcherChain.expectedArg ? rewriteSourceText(matcherChain.expectedArg.getText(), context) : undefined;
  let code: string | undefined;

  switch (callee.getName()) {
    case "text":
      if (matcherName === "eq" || matcherName === "equal") {
        code = `await expect(${locatorName}).toHaveText(${expectedText ?? `""`});`;
      }
      break;
    case "attr": {
      if (matcherName === "eq" || matcherName === "equal") {
        const attrName = actualArg.getArguments()[0]?.getText() ?? `""`;
        code = `await expect(${locatorName}).toHaveAttribute(${attrName}, ${expectedText ?? `""`});`;
      }
      break;
    }
    case "hasClass": {
      if (matcherName === "eq" || matcherName === "equal") {
        const className = actualArg.getArguments()[0]?.getText() ?? `""`;
        const normalizedExpected = expectedText?.trim();
        if (normalizedExpected === "false") {
          code = `await expect(${locatorName}).not.toHaveClass(new RegExp(${className}));`;
        } else {
          code = `await expect(${locatorName}).toHaveClass(new RegExp(${className}));`;
        }
      }
      break;
    }
    default:
      break;
  }

  if (!code) {
    return undefined;
  }

  return createStatement(code, [], false, [], extractCommentTrivia(statement));
}

function translateValueExpectationStatement(statement: Statement, context: TransformContext): StatementIR | undefined {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }

  const matcherChain = getExpectMatcherChain(statement.getExpression());
  if (!matcherChain) {
    return undefined;
  }

  const actualArg = matcherChain.expectCall.getArguments()[0];
  if (!actualArg || !Node.isExpression(actualArg)) {
    return undefined;
  }

  const matcherName = matcherChain.matcherName;
  const actualText = rewriteExpression(actualArg, context);
  const expectedText = matcherChain.expectedArg ? rewriteExpression(matcherChain.expectedArg, context) : undefined;

  let code: string | undefined;
  switch (matcherName) {
    case "eq":
    case "equal":
      code = `expect(${actualText}).toBe(${expectedText ?? "undefined"});`;
      break;
    case "contain":
    case "includes":
      code = `expect(${actualText}).toContain(${expectedText ?? `""`});`;
      break;
    default:
      break;
  }

  if (!code) {
    return undefined;
  }

  return createStatement(code, [], false, [], extractCommentTrivia(statement));
}

export function translateCallExpression(callExpression: CallExpression, context: TransformContext, asExpression = false): StatementIR | string {
  const analyzedChain = analyzeCommandChain(callExpression, context);
  if (analyzedChain) {
    const lowered = lowerCommandChain(analyzedChain, context, asExpression);
    return asExpression && lowered.subjectExpression && lowered.code === lowered.subjectExpression
      ? lowered.subjectExpression
      : createStatement(lowered.code, lowered.issues, lowered.unresolved, lowered.imports);
  }

  if (needsPageArgumentInjection(callExpression, context.helperCallNamesNeedingPage)) {
    const args = renderArguments(callExpression);
    const expression = callExpression.getExpression().getText();
    const invocation = rewriteSourceText(`${expression}(${[context.pageIdentifier, ...args].join(", ")})`, context);
    return asExpression ? invocation : createStatement(`await ${invocation};`);
  }

  const rawCall = rewriteSourceText(callExpression.getText(), context);
  return asExpression ? rawCall : createStatement(`await ${rawCall};`);
}

export function rewriteExpression(expression: Expression, context: TransformContext): string {
  const rewrittenJqueryExpression = rewriteSupportedJqueryExpression(expression, context);
  if (rewrittenJqueryExpression) {
    return rewrittenJqueryExpression;
  }

  if (Node.isCallExpression(expression)) {
    const translated = translateCallExpression(expression, context, true);
    if (typeof translated === "string") {
      return rewriteSourceText(translated, context);
    }

    return rewriteSourceText(translated.code.replace(/;$/, ""), context);
  }

  return rewriteSourceText(rewriteNewExpressionIfNeeded(
    expression.getText(),
    expression,
    context.pageObjectClassNames,
    context.pageIdentifier
  ), context);
}

function translateVariableDeclaration(declaration: VariableDeclaration, declarationKind: string, context: TransformContext): StatementIR {
  const name = declaration.getName();
  const initializer = declaration.getInitializer();

  if (!initializer) {
    return createStatement(
      isJavaScriptSource(context) ? `${declarationKind} ${name}: any;` : `${declarationKind} ${name};`
    );
  }

  const requireCall = getRequireCall(initializer);
  if (requireCall) {
    const outputPath = context.runtime.pathResolution.sourceToOutput.get(context.sourceFile.getFilePath()) ?? context.sourceFile.getFilePath();
    const isMutated = hasIdentifierMutationInScope(name, declaration);
    const moduleSpecifier = requireCall.moduleSpecifier;
    const resolvedSpecifier = resolveModuleImportSpecifier(context, context.sourceFile, outputPath, moduleSpecifier);

    if (isMutated && moduleSpecifier.endsWith(".json")) {
      const absoluteModulePath = path.resolve(context.sourceFile.getDirectoryPath(), moduleSpecifier);
      const projectRelativePath = path.relative(context.runtime.projectRoot, absoluteModulePath).replace(/\\/g, "/");
      bindSubjectKind(context, name, "value");
      return createStatement(
        `const ${name}: any = await loadProjectJson(${quote(projectRelativePath)});`,
        [
          createIssue(
            declaration,
            context.sourceFile.getFilePath(),
            "mutated-require",
            `Required JSON module "${moduleSpecifier}" is mutated, so cypw is loading a fresh object per test instead of hoisting an import.`,
            "warning",
            "mutated-require",
            "best_effort"
          )
        ]
      );
    }

    if (isMutated && !moduleSpecifier.endsWith(".json")) {
      const issue = createIssue(
        declaration,
        context.sourceFile.getFilePath(),
        "mutated-require",
        `Required module "${moduleSpecifier}" is mutated in scope and cannot be safely hoisted.`,
        "warning",
        "mutated-require",
        "manual_review"
      );
      return createStatement(`// ${context.runtime.config.reporting.inlineTodoPrefix}: ${issue.message}`, [issue], true);
    }

    bindSubjectKind(context, name, "value");
    const importAlias = `${name}Import`;
    return createStatement(
      `const ${name}: any = ${importAlias};`,
      [],
      false,
      [{
        moduleSpecifier: resolvedSpecifier,
        defaultImport: importAlias
      }]
    );
  }

  const rewrittenInitializer = rewriteExpression(initializer, context);
  bindSubjectKind(context, name, inferExpressionSubjectKind(rewrittenInitializer, context));
  const explicitType = isJavaScriptSource(context)
    ? resolveExplicitAnyType(initializer) ?? (inferExpressionSubjectKind(rewrittenInitializer, context) === "value" ? "any" : undefined)
    : undefined;
  return createStatement(`${declarationKind} ${name}${explicitType ? `: ${explicitType}` : ""} = ${rewrittenInitializer};`);
}

function translateIfStatement(statement: IfStatement, context: TransformContext): StatementIR {
  const condition = rewriteExpression(statement.getExpression(), context);
  const thenBlock = translateStatements(statement.getThenStatement().asKind(SyntaxKind.Block) ?? statement.getThenStatement(), context);
  const elseStatement = statement.getElseStatement();
  const elseBlock = elseStatement ? translateStatements(elseStatement.asKind(SyntaxKind.Block) ?? elseStatement, context) : undefined;
  const issues = [...thenBlock.flatMap((entry) => entry.issues), ...(elseBlock?.flatMap((entry) => entry.issues) ?? [])];
  const unresolved = thenBlock.some((entry) => entry.unresolved) || Boolean(elseBlock?.some((entry) => entry.unresolved));
  const elseCode = elseBlock ? ` else {\n${elseBlock.map((entry) => inlineStatementText(entry)).join("\n")}\n}` : "";

  return createStatement(
    `if (${condition}) {\n${thenBlock.map((entry) => inlineStatementText(entry)).join("\n")}\n}${elseCode}`,
    issues,
    unresolved,
    [],
    extractCommentTrivia(statement)
  );
}

export function translateStatement(statement: Statement, context: TransformContext): StatementIR {
  const comments = extractCommentTrivia(statement);

  if (Node.isVariableStatement(statement)) {
    const declarationKind = statement.getDeclarationKind();
    const translatedDeclarations = statement.getDeclarations().map((declaration) => translateVariableDeclaration(declaration, declarationKind, context));
    const issues = translatedDeclarations.flatMap((entry) => entry.issues);
    const unresolved = translatedDeclarations.some((entry) => entry.unresolved);
    const imports = translatedDeclarations.flatMap((entry) => entry.imports ?? []);

    return createStatement(translatedDeclarations.map((entry) => entry.code).join("\n"), issues, unresolved, imports, comments);
  }

  if (Node.isExpressionStatement(statement)) {
    const jqueryExpectation = translateJqueryExpectationStatement(statement, context);
    if (jqueryExpectation) {
      return jqueryExpectation;
    }

    const valueExpectation = translateValueExpectationStatement(statement, context);
    if (valueExpectation) {
      return valueExpectation;
    }

    const expression = statement.getExpression();
    if (Node.isCallExpression(expression)) {
      const translated = translateCallExpression(expression, context);
      return typeof translated === "string"
        ? createStatement(`${translated};`, [], false, [], comments)
        : { ...translated, comments: translated.comments ?? comments };
    }

    return createStatement(`${rewriteExpression(expression, context)};`, [], false, [], comments);
  }

  if (Node.isReturnStatement(statement)) {
    const translated = translateReturnStatement(statement, context);
    return {
      ...translated,
      comments: translated.comments ?? comments
    };
  }

  if (Node.isIfStatement(statement)) {
    return translateIfStatement(statement, context);
  }

  if (Node.isBlock(statement)) {
    const translated = translateStatements(statement, context);
    const issues = translated.flatMap((entry) => entry.issues);
    const unresolved = translated.some((entry) => entry.unresolved);
    const imports = translated.flatMap((entry) => entry.imports ?? []);
    return createStatement(`{\n${translated.map((entry) => inlineStatementText(entry)).join("\n")}\n}`, issues, unresolved, imports, comments);
  }

  const unresolved = unresolvedStatement(statement, context, `Statement kind "${statement.getKindName()}" requires manual migration.`);
  return {
    ...unresolved,
    comments: unresolved.comments ?? comments
  };
}

export function translateReturnStatement(statement: ReturnStatement, context: TransformContext): StatementIR {
  const expression = statement.getExpression();
  if (!expression) {
    return createStatement("return;");
  }

  if (Node.isCallExpression(expression)) {
    const translated = translateCallExpression(expression, context, true);
    if (typeof translated === "string") {
      return createStatement(`return ${translated};`);
    }

    return createStatement(
      translated.code.startsWith("await ")
        ? `return ${translated.code.replace(/;$/, "")};`
        : translated.code.replace(/^await /, "return ").replace(/;$/, ";"),
      translated.issues,
      translated.unresolved,
      translated.imports ?? []
    );
  }

  return createStatement(`return ${rewriteExpression(expression, context)};`);
}

export function translateStatements(blockOrStatement: Block | Statement, context: TransformContext): StatementIR[] {
  const statements = Node.isBlock(blockOrStatement) ? blockOrStatement.getStatements() : [blockOrStatement];
  return statements.map((statement) => translateStatement(statement, context));
}
