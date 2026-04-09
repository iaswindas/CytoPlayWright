export type FileCategory =
  | "spec"
  | "page-object"
  | "helper"
  | "support"
  | "fixture"
  | "utility"
  | "other";
export type SourceLanguage = "ts" | "js";
export type SpecRole = "entry" | "module";

export type MigrationStatus =
  | "converted"
  | "converted_with_warnings"
  | "manual_review"
  | "unsupported"
  | "failed";

export type IssueSeverity = "info" | "warning" | "error";
export type ConversionStrategy = "direct" | "best_effort" | "manual_review";
export type SubjectKind = "locator" | "collection" | "response" | "value" | "unknown";

export interface Location {
  line?: number;
  column?: number;
}

export interface MigrationIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
  sourcePath: string;
  location?: Location;
  pattern?: string;
  snippet?: string;
  suggestedAction?: string;
  pluginName?: string;
  conversionStrategy?: ConversionStrategy;
  aliasHoisted?: boolean;
  forcedSerialMode?: boolean;
}

export interface CommandUsageMap {
  [commandName: string]: number;
}

export interface DiscoveredFileMetadata {
  sourceLanguage: SourceLanguage;
  hasCypress: boolean;
  hasMocha: boolean;
  specLike: boolean;
  specEntry: boolean;
  specRole?: SpecRole;
  hasPageObjectClass: boolean;
  hasIntercept: boolean;
  hasTask: boolean;
  hasFixture: boolean;
  hasRequest: boolean;
  commandUsages: CommandUsageMap;
}

export interface DiscoveredFile {
  path: string;
  relativePath: string;
  category: FileCategory;
  imports: string[];
  exports: string[];
  customCommands: string[];
  metadata: DiscoveredFileMetadata;
}

export interface ProjectDiscovery {
  projectRoot: string;
  sourceRootPaths: string[];
  specFiles: DiscoveredFile[];
  pageObjects: DiscoveredFile[];
  helpers: DiscoveredFile[];
  supportFiles: DiscoveredFile[];
  fixtures: DiscoveredFile[];
  utilityFiles: DiscoveredFile[];
  otherFiles: DiscoveredFile[];
  customCommands: string[];
  allFiles: DiscoveredFile[];
}

export interface GraphNode {
  path: string;
  category: FileCategory;
  dependencies: string[];
  dependents: string[];
}

export interface ProjectGraph {
  nodes: Record<string, GraphNode>;
}

export interface FileAnalysis {
  sourcePath: string;
  category: FileCategory;
  sourceLanguage: SourceLanguage;
  specLike: boolean;
  specRole?: SpecRole;
  confidence: number;
  status: MigrationStatus;
  directMappings: string[];
  unresolvedPatterns: string[];
  pluginCandidates: string[];
  issues: MigrationIssue[];
  commandUsages: CommandUsageMap;
  generatedPath?: string;
}

export interface ProjectAnalysisSummary {
  totalFiles: number;
  specFiles: number;
  pageObjects: number;
  helpers: number;
  supportFiles: number;
  fixtures: number;
  convertedReadyFiles: number;
  manualReviewFiles: number;
  unsupportedFiles: number;
}

export interface ControlFlowSummary {
  filesWithControlFlow: number;
  upgradedFiles: number;
  partialReviewFiles: number;
  strategyCounts: Record<ConversionStrategy, number>;
}

export interface ProjectAnalysis {
  files: FileAnalysis[];
  readinessScore: number;
  topUnsupportedPatterns: Array<{ pattern: string; count: number }>;
  hotspots: Array<{ sourcePath: string; issueCount: number; confidence: number }>;
  summary: ProjectAnalysisSummary;
  controlFlowSummary: ControlFlowSummary;
}

export interface GeneratedArtifact {
  path: string;
  content: string;
}

export interface GeneratedFileRecord {
  sourcePath: string;
  outputPath: string;
  category: FileCategory;
  sourceLanguage: SourceLanguage;
  specLike: boolean;
  specRole?: SpecRole;
  status: MigrationStatus;
  confidence: number;
  issues: MigrationIssue[];
  pluginHits: string[];
}

export interface ManifestData {
  projectRoot: string;
  outputRoot: string;
  generatedAt: string;
  files: GeneratedFileRecord[];
}

export interface HandoffEntry {
  sourcePath: string;
  outputPath?: string;
  confidence: number;
  prompt: string;
  issues: MigrationIssue[];
}

export interface ReportData {
  generatedAt: string;
  readinessScore: number;
  summary: ProjectAnalysisSummary;
  files: GeneratedFileRecord[];
  topUnsupportedPatterns: Array<{ pattern: string; count: number }>;
  hotspots: Array<{ sourcePath: string; issueCount: number; confidence: number }>;
  controlFlowSummary: ControlFlowSummary;
  validation?: ValidationResult;
}

export interface ValidationDiagnostic {
  filePath: string;
  line: number;
  column: number;
  code: string;
  message: string;
  category: "error" | "warning";
}

export interface ValidationResult {
  passed: boolean;
  diagnostics: ValidationDiagnostic[];
}
