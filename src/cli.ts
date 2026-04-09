#!/usr/bin/env node
import path from "node:path";
import { loadConfig, writeDefaultConfig } from "./config/load-config";
import { createRuntime } from "./cli/create-runtime";
import { generateProject } from "./generation/generate-project";
import { readTextFile, writeTextFile } from "./shared/fs";
import { CYPW_STATE_DIRECTORY } from "./shared/constants";
import type { GeneratedFileRecord, ManifestData, ReportData, ValidationResult } from "./shared/types";
import { writeAnalysisReport, writeConversionReports } from "./reporting/write-reports";
import { validateOutput } from "./validation/validate-output";

interface CliOptions {
  projectRoot: string;
  configPath?: string;
}

function parseOptions(argv: string[]): { command?: string; options: CliOptions } {
  const command = argv[0];
  const options: CliOptions = {
    projectRoot: process.cwd()
  };

  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--project-root" && next) {
      options.projectRoot = path.resolve(next);
      index += 1;
      continue;
    }

    if (current === "--config" && next) {
      options.configPath = next;
      index += 1;
    }
  }

  return { command, options };
}

function printUsage(): void {
  console.log(`cypw <command> [options]

Commands:
  init       Create cypw.config.jsonc with enterprise defaults
  analyze    Analyze Cypress sources and write readiness reports
  convert    Convert Cypress sources to side-by-side Playwright output
  validate   Type-check generated Playwright output and refresh reports

Options:
  --project-root <path>
  --config <path>
`);
}

function mergeValidation(records: GeneratedFileRecord[], validation: ValidationResult): GeneratedFileRecord[] {
  const failingPaths = new Set(validation.diagnostics.filter((diagnostic) => diagnostic.category === "error").map((diagnostic) => diagnostic.filePath));

  return records.map((record) => ({
    ...record,
    status: failingPaths.has(record.outputPath) ? "failed" : record.status
  }));
}

async function loadManifest(projectRoot: string): Promise<ManifestData> {
  const manifestPath = path.resolve(projectRoot, CYPW_STATE_DIRECTORY, "manifest.json");
  const raw = await readTextFile(manifestPath);
  return JSON.parse(raw) as ManifestData;
}

async function writeManifest(projectRoot: string, manifest: ManifestData): Promise<void> {
  const manifestPath = path.resolve(projectRoot, CYPW_STATE_DIRECTORY, "manifest.json");
  await writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function handleInit(options: CliOptions): Promise<void> {
  const configPath = await writeDefaultConfig(options.projectRoot, options.configPath);
  console.log(`Initialized config at ${configPath}`);
}

async function handleAnalyze(options: CliOptions): Promise<void> {
  const runtime = await createRuntime(options.projectRoot, options.configPath);
  const report = await writeAnalysisReport(runtime);
  console.log(`Readiness score: ${report.readinessScore}`);
  console.log(`Report written to ${path.resolve(options.projectRoot, CYPW_STATE_DIRECTORY, "report.json")}`);
}

async function handleConvert(options: CliOptions): Promise<void> {
  const runtime = await createRuntime(options.projectRoot, options.configPath);
  const generation = await generateProject(runtime);
  const validation = await validateOutput(runtime.projectRoot, runtime.config.outputRoot);
  const records = mergeValidation(generation.records, validation);
  await writeConversionReports(runtime, records, validation);
  console.log(`Generated ${generation.artifacts.length} artifacts under ${path.resolve(runtime.projectRoot, runtime.config.outputRoot)}`);
  console.log(`Validation ${validation.passed ? "passed" : "found issues"}.`);
}

async function handleValidate(options: CliOptions): Promise<void> {
  const loadedConfig = await loadConfig(options.projectRoot, options.configPath);
  const manifest = await loadManifest(options.projectRoot);
  const validation = await validateOutput(options.projectRoot, loadedConfig.config.outputRoot);
  const runtime = await createRuntime(options.projectRoot, options.configPath);
  const updatedFiles = mergeValidation(manifest.files, validation);
  const updatedManifest: ManifestData = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    files: updatedFiles
  };

  await writeManifest(options.projectRoot, updatedManifest);
  await writeConversionReports(runtime, updatedFiles, validation);
  console.log(`Validation ${validation.passed ? "passed" : "failed"}.`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseOptions(argv);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "init":
      await handleInit(options);
      return;
    case "analyze":
      await handleAnalyze(options);
      return;
    case "convert":
      await handleConvert(options);
      return;
    case "validate":
      await handleValidate(options);
      return;
    default:
      printUsage();
      throw new Error(`Unknown command "${command}".`);
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
