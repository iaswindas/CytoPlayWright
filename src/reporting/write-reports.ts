import path from "node:path";
import { CYPW_STATE_DIRECTORY } from "../shared/constants";
import { ensureDirectory, writeTextFile } from "../shared/fs";
import type {
  GeneratedFileRecord,
  HandoffEntry,
  ManifestData,
  ProjectAnalysis,
  ReportData,
  ValidationResult
} from "../shared/types";
import type { CompilerRuntime } from "../shared/runtime";
import { createMarkdownReport } from "./markdown";

function buildHandoffEntries(records: GeneratedFileRecord[]): HandoffEntry[] {
  const handoffs: HandoffEntry[] = [];

  for (const record of records) {
    const reviewIssues = record.issues.filter(
      (issue) =>
        issue.code.includes("review") ||
        issue.code === "manual-review" ||
        issue.severity === "error"
    );

    if (reviewIssues.length === 0) {
      continue;
    }

    handoffs.push({
      sourcePath: record.sourcePath,
      outputPath: record.outputPath,
      confidence: record.confidence,
      prompt: [
        `Review the generated Playwright migration for ${record.sourcePath}.`,
        `Focus on unresolved Cypress constructs, runtime assumptions, and business flow parity.`,
        `Issues: ${reviewIssues.map((issue) => issue.message).join(" | ")}`
      ].join(" "),
      issues: reviewIssues
    });
  }

  return handoffs;
}

function buildManifest(runtime: CompilerRuntime, records: GeneratedFileRecord[]): ManifestData {
  return {
    projectRoot: runtime.projectRoot,
    outputRoot: path.resolve(runtime.projectRoot, runtime.config.outputRoot),
    generatedAt: new Date().toISOString(),
    files: records
  };
}

function buildReport(
  analysis: ProjectAnalysis,
  records: GeneratedFileRecord[],
  validation?: ValidationResult
): ReportData {
  return {
    generatedAt: new Date().toISOString(),
    readinessScore: analysis.readinessScore,
    summary: analysis.summary,
    files: records,
    topUnsupportedPatterns: analysis.topUnsupportedPatterns,
    hotspots: analysis.hotspots,
    controlFlowSummary: analysis.controlFlowSummary,
    validation
  };
}

export async function writeAnalysisReport(runtime: CompilerRuntime): Promise<ReportData> {
  if (!runtime.analysis) {
    throw new Error("Project analysis is missing.");
  }

  const stateDirectory = path.resolve(runtime.projectRoot, CYPW_STATE_DIRECTORY);
  await ensureDirectory(stateDirectory);

  const report = buildReport(runtime.analysis, []);
  await writeTextFile(path.resolve(stateDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeTextFile(path.resolve(stateDirectory, "report.md"), createMarkdownReport(report));
  return report;
}

export async function writeConversionReports(
  runtime: CompilerRuntime,
  records: GeneratedFileRecord[],
  validation?: ValidationResult
): Promise<ReportData> {
  if (!runtime.analysis) {
    throw new Error("Project analysis is missing.");
  }

  const stateDirectory = path.resolve(runtime.projectRoot, CYPW_STATE_DIRECTORY);
  await ensureDirectory(stateDirectory);

  const manifest = buildManifest(runtime, records);
  const report = buildReport(runtime.analysis, records, validation);
  const handoff = buildHandoffEntries(records);

  await writeTextFile(path.resolve(stateDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeTextFile(path.resolve(stateDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeTextFile(path.resolve(stateDirectory, "report.md"), createMarkdownReport(report));
  await writeTextFile(path.resolve(stateDirectory, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`);

  return report;
}
