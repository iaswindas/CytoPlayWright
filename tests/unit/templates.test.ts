import { describe, expect, it } from "vitest";
import {
  createBaseTestTemplate,
  createPlaywrightConfigTemplate,
  createGeneratedTsconfigTemplate,
  createGlobalSetupTemplate
} from "../../src/generation/templates";

describe("templates", () => {
  describe("baseTest template", () => {
    const template = createBaseTestTemplate();

    it("exports test and expect", () => {
      expect(template).toContain("export const test = base.extend");
      expect(template).toContain("export { expect };");
    });

    it("includes migrationState fixture", () => {
      expect(template).toContain("migrationState:");
      expect(template).toContain("responseAliases: new Map()");
      expect(template).toContain("locatorAliases: new Map()");
      expect(template).toContain("valueAliases: new Map()");
    });

    it("includes loadFixture fixture", () => {
      expect(template).toContain("loadFixture:");
      expect(template).toContain("cypress/fixtures");
    });

    it("includes runTask fixture", () => {
      expect(template).toContain("runTask:");
      expect(template).toContain("TODO(cypw): configure task handler");
    });

    it("includes alias management functions", () => {
      expect(template).toContain("export function registerAlias");
      expect(template).toContain("export async function waitForAlias");
      expect(template).toContain("export function registerLocatorAlias");
      expect(template).toContain("export function getLocatorAlias");
      expect(template).toContain("export function registerValueAlias");
      expect(template).toContain("export async function getValueAlias");
    });

    it("includes normalizeResponse utility", () => {
      expect(template).toContain("export async function normalizeResponse");
      expect(template).toContain("NormalizedResponse");
    });

    it("includes route mocking utilities (Phase 2)", () => {
      expect(template).toContain("export async function mockRoute");
      expect(template).toContain("export async function stubApiResponse");
      expect(template).toContain("MockRouteOptions");
      expect(template).toContain("route.fulfill");
    });

    it("includes routeAliases in MigrationState", () => {
      expect(template).toContain("routeAliases: Map<string, { url: string; fulfilled: boolean }>");
    });
  });

  describe("playwright.config template", () => {
    const template = createPlaywrightConfigTemplate();

    it("uses defineConfig", () => {
      expect(template).toContain("defineConfig");
    });

    it("configures multiple browser projects", () => {
      expect(template).toContain("chromium");
      expect(template).toContain("firefox");
      expect(template).toContain("webkit");
    });

    it("has CI-aware settings", () => {
      expect(template).toContain("process.env.CI");
      expect(template).toContain("forbidOnly");
      expect(template).toContain("retries");
      expect(template).toContain("workers");
    });

    it("includes trace and screenshot configuration", () => {
      expect(template).toContain("trace: \"on-first-retry\"");
      expect(template).toContain("screenshot: \"only-on-failure\"");
      expect(template).toContain("video: \"retain-on-failure\"");
    });

    it("includes baseURL from env", () => {
      expect(template).toContain("PLAYWRIGHT_BASE_URL");
    });

    it("includes webServer placeholder", () => {
      expect(template).toContain("webServer");
    });

    it("includes junit reporter for CI", () => {
      expect(template).toContain("junit");
    });
  });

  describe("tsconfig template", () => {
    const template = createGeneratedTsconfigTemplate();

    it("targets ES2022", () => {
      expect(template).toContain("ES2022");
    });

    it("includes Playwright types", () => {
      expect(template).toContain("@playwright/test");
    });
  });

  describe("globalSetup template", () => {
    const template = createGlobalSetupTemplate();

    it("exports default async function", () => {
      expect(template).toContain("export default async function globalSetup");
    });

    it("imports from Playwright", () => {
      expect(template).toContain("from \"@playwright/test\"");
    });

    it("includes auth example", () => {
      expect(template).toContain("storageState");
    });
  });
});
