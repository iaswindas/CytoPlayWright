import type { ReportData } from "../shared/types";

export function createMarkdownReport(report: ReportData): string {
  const summary = [
    `- Readiness score: ${report.readinessScore}`,
    `- Total files: ${report.summary.totalFiles}`,
    `- Converted-ready files: ${report.summary.convertedReadyFiles}`,
    `- Manual review files: ${report.summary.manualReviewFiles}`,
    `- Unsupported files: ${report.summary.unsupportedFiles}`
  ].join("\n");

  const unsupported = report.topUnsupportedPatterns.length > 0
    ? report.topUnsupportedPatterns.map((entry) => `- ${entry.pattern}: ${entry.count}`).join("\n")
    : "- none";

  const hotspots = report.hotspots.length > 0
    ? report.hotspots
        .map((entry) => `- ${entry.sourcePath} | issues: ${entry.issueCount} | confidence: ${entry.confidence}`)
        .join("\n")
    : "- none";

  const controlFlow = [
    `- Files with control flow: ${report.controlFlowSummary.filesWithControlFlow}`,
    `- Upgraded files: ${report.controlFlowSummary.upgradedFiles}`,
    `- Partial review files: ${report.controlFlowSummary.partialReviewFiles}`,
    `- Strategies: direct=${report.controlFlowSummary.strategyCounts.direct}, best_effort=${report.controlFlowSummary.strategyCounts.best_effort}, manual_review=${report.controlFlowSummary.strategyCounts.manual_review}`
  ].join("\n");

  const fileRows = report.files.length > 0
    ? report.files
        .map(
          (file) =>
            `- ${file.sourcePath} -> ${file.outputPath} | status: ${file.status} | confidence: ${file.confidence}`
        )
        .join("\n")
    : "- none";

  const validation = report.validation
    ? report.validation.passed
      ? "- validation passed"
      : report.validation.diagnostics
          .map(
            (diagnostic) =>
              `- ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`
          )
          .join("\n")
    : "- not run";

  return `# cypw Migration Report

## Summary
${summary}

## Unsupported Patterns
${unsupported}

## Cleanup Hotspots
${hotspots}

## Control Flow
${controlFlow}

## File Status
${fileRows}

## Validation
${validation}
`;
}
