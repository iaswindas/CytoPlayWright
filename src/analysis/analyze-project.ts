import type { CompilerRuntime } from "../shared/runtime";
import type {
  ControlFlowSummary,
  FileAnalysis,
  MigrationIssue,
  MigrationStatus,
  ProjectAnalysis,
  ProjectAnalysisSummary
} from "../shared/types";

const SUPPORTED_COMMANDS = new Set([
  "visit",
  "get",
  "find",
  "contains",
  "click",
  "type",
  "select",
  "check",
  "uncheck",
  "should",
  "and",
  "intercept",
  "wait",
  "request",
  "fixture",
  "task",
  "as",
  "then",
  "within",
  "each",
  "wrap",
  "window",
  // Phase 1: Newly supported commands
  "clear",
  "dblclick",
  "rightclick",
  "focus",
  "blur",
  "hover",
  "scrollIntoView",
  "scrollTo",
  "trigger",
  "first",
  "last",
  "eq",
  "parent",
  "children",
  "siblings",
  "next",
  "prev",
  "closest",
  "filter",
  "invoke",
  "its",
  "url",
  "location",
  "title",
  "focused",
  "reload",
  "go",
  "viewport",
  "clearCookies",
  "clearLocalStorage",
  "log",
  "screenshot",
  "clock",
  "tick",
  // Phase 4: Session and origin (best-effort)
  "session",
  "origin"
]);

const UNSUPPORTED_COMMANDS = new Set(["spread"]);

const CONTROL_FLOW_PATTERN_MAP: Record<string, { pattern: string; strategy: "direct" | "best_effort" }> = {
  then: { pattern: "callback-chain", strategy: "best_effort" },
  within: { pattern: "scoped-locator", strategy: "direct" },
  each: { pattern: "collection-iteration", strategy: "best_effort" },
  wrap: { pattern: "alias-value-flow", strategy: "direct" },
  session: { pattern: "session-setup", strategy: "best_effort" },
  origin: { pattern: "cross-origin", strategy: "best_effort" }
};

function createIssue(
  sourcePath: string,
  code: string,
  message: string,
  pattern: string,
  severity: "info" | "warning" | "error" = "warning",
  conversionStrategy?: MigrationIssue["conversionStrategy"]
): MigrationIssue {
  return {
    code,
    message,
    severity,
    sourcePath,
    pattern,
    conversionStrategy
  };
}

function statusFromConfidence(confidence: number, issues: MigrationIssue[]): MigrationStatus {
  const hasError = issues.some((issue) => issue.severity === "error");
  if (hasError || confidence < 0.35) {
    return "unsupported";
  }

  if (issues.length === 0) {
    return "converted";
  }

  if (confidence >= 0.8) {
    return "converted_with_warnings";
  }

  return "manual_review";
}

function summarize(discoverySummary: CompilerRuntime["discovery"]): ProjectAnalysisSummary {
  return {
    totalFiles: discoverySummary.allFiles.length,
    specFiles: discoverySummary.specFiles.length,
    pageObjects: discoverySummary.pageObjects.length,
    helpers: discoverySummary.helpers.length + discoverySummary.otherFiles.filter((file) => file.metadata.hasCypress).length,
    supportFiles: discoverySummary.supportFiles.length,
    fixtures: discoverySummary.fixtures.length,
    convertedReadyFiles: 0,
    manualReviewFiles: 0,
    unsupportedFiles: 0
  };
}

export function analyzeProject(runtime: CompilerRuntime): ProjectAnalysis {
  const files: FileAnalysis[] = [];
  const unsupportedPatternCounts = new Map<string, number>();
  const summary = summarize(runtime.discovery);
  const controlFlowSummary: ControlFlowSummary = {
    filesWithControlFlow: 0,
    upgradedFiles: 0,
    partialReviewFiles: 0,
    strategyCounts: {
      direct: 0,
      best_effort: 0,
      manual_review: 0
    }
  };

  for (const file of runtime.discovery.allFiles) {
    const issues: MigrationIssue[] = [];
    const directMappings: string[] = [];
    const unresolvedPatterns: string[] = [];
    const pluginCandidates: string[] = [];
    let confidence = file.category === "fixture" ? 1 : 0.97;
    let hasControlFlow = false;
    let fileUpgraded = false;

    const sourceFile = runtime.sourceFileMap.get(file.path);
    const sourceText = sourceFile?.getFullText() ?? "";

    if (file.metadata.sourceLanguage === "js") {
      issues.push(
        createIssue(
          file.path,
          "js-typing",
          "JavaScript source will use compile-safe TypeScript fallbacks during migration.",
          "js-typing",
          "info",
          "best_effort"
        )
      );
      confidence -= 0.03;
    }

    for (const commandName of Object.keys(file.metadata.commandUsages)) {
      if (CONTROL_FLOW_PATTERN_MAP[commandName] && file.metadata.commandUsages[commandName] > 0) {
        hasControlFlow = true;
        const { pattern, strategy } = CONTROL_FLOW_PATTERN_MAP[commandName];
        issues.push(
          createIssue(
            file.path,
            "control-flow-supported",
            `Control-flow pattern "${commandName}" will use ${strategy === "direct" ? "direct" : "best-effort"} conversion.`,
            pattern,
            "info",
            strategy
          )
        );
        unsupportedPatternCounts.set(pattern, (unsupportedPatternCounts.get(pattern) ?? 0) + 1);
        controlFlowSummary.strategyCounts[strategy] += 1;
        confidence -= strategy === "best_effort" ? 0.03 : 0.01;
        fileUpgraded = true;
      }

      if (SUPPORTED_COMMANDS.has(commandName)) {
        directMappings.push(commandName);
        continue;
      }

      if (UNSUPPORTED_COMMANDS.has(commandName)) {
        const issue = createIssue(
          file.path,
          "unsupported-command",
          `Unsupported Cypress command "${commandName}" requires manual migration.`,
          commandName,
          "error"
        );
        issues.push(issue);
        unresolvedPatterns.push(commandName);
        unsupportedPatternCounts.set(commandName, (unsupportedPatternCounts.get(commandName) ?? 0) + 1);
        confidence -= 0.18;
        continue;
      }

      if (file.metadata.commandUsages[commandName] > 0 && !SUPPORTED_COMMANDS.has(commandName)) {
        const mappedCustomCommand = runtime.config.customCommandMap[commandName];
        if (mappedCustomCommand) {
          directMappings.push(`custom:${commandName}`);
          confidence -= 0.02;
        } else {
          issues.push(
            createIssue(
              file.path,
              "custom-command-review",
              `Custom command "${commandName}" needs config mapping or plugin translation.`,
              commandName
            )
          );
          unresolvedPatterns.push(commandName);
          unsupportedPatternCounts.set(commandName, (unsupportedPatternCounts.get(commandName) ?? 0) + 1);
          confidence -= 0.08;
        }
      }
    }

    if (/cy\.get\(\s*["'`]@/.test(sourceText)) {
      hasControlFlow = true;
      fileUpgraded = true;
      unsupportedPatternCounts.set("alias-value-flow", (unsupportedPatternCounts.get("alias-value-flow") ?? 0) + 1);
      controlFlowSummary.strategyCounts.direct += 1;
      issues.push(
        createIssue(
          file.path,
          "alias-flow-supported",
          "Locator/value alias reads will use alias-aware conversion.",
          "alias-value-flow",
          "info",
          "direct"
        )
      );
      confidence -= 0.01;
    }

    if (/cy\.window\s*\(/.test(sourceText)) {
      hasControlFlow = true;
      fileUpgraded = true;
      unsupportedPatternCounts.set("runtime-recipe", (unsupportedPatternCounts.get("runtime-recipe") ?? 0) + 1);
      controlFlowSummary.strategyCounts.best_effort += 1;
      issues.push(
        createIssue(
          file.path,
          "runtime-recipe",
          "Browser-runtime callbacks will use recipe-based conversion when patterns are recognized.",
          "runtime-recipe",
          "info",
          "best_effort"
        )
      );
      confidence -= 0.03;
    }

    if (/\brequire\s*\(/.test(sourceText)) {
      issues.push(
        createIssue(
          file.path,
          "inline-require",
          "CommonJS require() usage will be hoisted or fresh-loaded depending on mutation safety.",
          "inline-require",
          "info",
          "best_effort"
        )
      );
      confidence -= 0.02;
    }

    if (/\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(sourceText)) {
      issues.push(
        createIssue(
          file.path,
          "commonjs-export",
          "CommonJS exports will be rewritten to Playwright-compatible ES module TypeScript.",
          "commonjs-export",
          "info",
          "best_effort"
        )
      );
      confidence -= 0.02;
    }

    if (runtime.config.reporting.strictControlFlow && hasControlFlow) {
      issues.push(
        createIssue(
          file.path,
          "control-flow-strict",
          "strictControlFlow is enabled, so callback-heavy conversions should be reviewed carefully.",
          "callback-chain",
          "warning",
          "manual_review"
        )
      );
      controlFlowSummary.strategyCounts.manual_review += 1;
      confidence -= 0.06;
    }

    for (const plugin of runtime.plugins) {
      const detections = plugin.detectFile?.({
        sourceFile: sourceFile!,
        analysis: {
          sourcePath: file.path,
          category: file.category,
          sourceLanguage: file.metadata.sourceLanguage,
          confidence,
          status: "manual_review",
          directMappings,
          unresolvedPatterns,
          pluginCandidates,
          issues,
          commandUsages: file.metadata.commandUsages
        }
      });

      for (const detection of detections ?? []) {
        pluginCandidates.push(detection.pluginName);
        issues.push(
          createIssue(
            file.path,
            "plugin-detection",
            detection.message,
            detection.pattern,
            "info"
          )
        );
        confidence -= 0.01;
      }
    }

    if (file.category === "support" || file.category === "fixture") {
      confidence = Math.max(confidence, 0.9);
    }

    if (file.category === "other" && !file.metadata.hasCypress) {
      confidence = 1;
    }

    confidence = Math.max(0.05, Math.min(1, Number(confidence.toFixed(2))));
    const status = statusFromConfidence(confidence, issues);
    const generatedPath = runtime.pathResolution.sourceToOutput.get(file.path);

    const analysis: FileAnalysis = {
      sourcePath: file.path,
      category: file.category,
      sourceLanguage: file.metadata.sourceLanguage,
      confidence,
      status,
      directMappings,
      unresolvedPatterns,
      pluginCandidates,
      issues,
      commandUsages: file.metadata.commandUsages,
      generatedPath
    };

    if (status === "converted" || status === "converted_with_warnings") {
      summary.convertedReadyFiles += 1;
    } else if (status === "manual_review") {
      summary.manualReviewFiles += 1;
    } else if (status === "unsupported") {
      summary.unsupportedFiles += 1;
    }

    if (hasControlFlow) {
      controlFlowSummary.filesWithControlFlow += 1;
      if (status === "manual_review" || status === "converted_with_warnings") {
        controlFlowSummary.partialReviewFiles += 1;
      }
      if (fileUpgraded && status !== "unsupported") {
        controlFlowSummary.upgradedFiles += 1;
      }
    }

    files.push(analysis);
  }

  const readinessScore = files.length === 0
    ? 1
    : Number(
        (
          files.reduce((total, file) => total + file.confidence, 0) /
          files.length
        ).toFixed(2)
      );

  const topUnsupportedPatterns = [...unsupportedPatternCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({ pattern, count }));

  const hotspots = files
    .map((file) => ({
      sourcePath: file.sourcePath,
      issueCount: file.issues.length,
      confidence: file.confidence
    }))
    .filter((entry) => entry.issueCount > 0)
    .sort((left, right) => {
      if (right.issueCount !== left.issueCount) {
        return right.issueCount - left.issueCount;
      }

      return left.confidence - right.confidence;
    })
    .slice(0, 15);

  return {
    files,
    readinessScore,
    topUnsupportedPatterns,
    hotspots,
    summary,
    controlFlowSummary
  };
}
