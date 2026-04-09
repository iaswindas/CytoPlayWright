import { describe, expect, it } from "vitest";
import { rewriteCypressGlobals } from "../../src/transforms/env-transform";

describe("env-transform", () => {
  it("rewrites Cypress.env('KEY') to process.env.KEY", () => {
    const input = `const apiKey = Cypress.env('API_KEY');`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain(`(process.env.API_KEY ?? "")`);
    expect(result).not.toContain("Cypress.env");
  });

  it("rewrites Cypress.env() without args to process.env", () => {
    const input = `const env = Cypress.env();`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain("process.env");
    expect(result).not.toContain("Cypress.env");
  });

  it("rewrites Cypress.config('baseUrl')", () => {
    const input = `const url = Cypress.config('baseUrl');`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain("PLAYWRIGHT_BASE_URL");
    expect(result).not.toContain("Cypress.config");
  });

  it("rewrites Cypress.config with arbitrary keys", () => {
    const input = `const v = Cypress.config('viewportWidth');`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain("CYPRESS_viewportWidth");
  });

  it("rewrites Cypress.platform and Cypress.arch", () => {
    const input = `const p = Cypress.platform; const a = Cypress.arch;`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain("process.platform");
    expect(result).toContain("process.arch");
  });

  it("rewrites Cypress.version to \"migrated\"", () => {
    const input = `console.log(Cypress.version);`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain('"migrated"');
  });

  it("handles multiple rewrites in the same text", () => {
    const input = `const key = Cypress.env('API_KEY'); const base = Cypress.config('baseUrl'); const p = Cypress.platform;`;
    const result = rewriteCypressGlobals(input);
    expect(result).toContain("process.env.API_KEY");
    expect(result).toContain("PLAYWRIGHT_BASE_URL");
    expect(result).toContain("process.platform");
  });

  it("leaves non-Cypress text unchanged", () => {
    const input = `const x = someFunction(); console.log("hello");`;
    const result = rewriteCypressGlobals(input);
    expect(result).toBe(input);
  });
});
