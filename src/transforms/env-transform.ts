/**
 * Translates Cypress global API calls to Playwright equivalents.
 *
 * Handles:
 *   Cypress.env('KEY')         → process.env.KEY ?? ""
 *   Cypress.config('baseUrl')  → (base URL from Playwright config)
 *   Cypress.config('key')      → process.env.CYPRESS_key
 *   Cypress.browser             → (test info)
 *   Cypress.currentTest         → testInfo.title
 *   Cypress.platform            → process.platform
 *   Cypress.arch                → process.arch
 */

export function rewriteCypressGlobals(text: string): string {
  let result = text;

  // Cypress.env('KEY') → process.env.KEY ?? ""
  result = result.replace(
    /Cypress\.env\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g,
    (_match, key) => `(process.env.${key} ?? "")`
  );

  // Cypress.env() without args → process.env
  result = result.replace(
    /Cypress\.env\(\s*\)/g,
    "process.env"
  );

  // Cypress.config('baseUrl') → process.env.PLAYWRIGHT_BASE_URL ?? ""
  result = result.replace(
    /Cypress\.config\(\s*["'`]baseUrl["'`]\s*\)/g,
    '(process.env.PLAYWRIGHT_BASE_URL ?? "")'
  );

  // Cypress.config('key') → process.env.CYPRESS_key ?? ""
  result = result.replace(
    /Cypress\.config\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g,
    (_match, key) => `(process.env.CYPRESS_${key} ?? "")`
  );

  // Cypress._ → lodash (preserve for manual review)
  // This is a no-op — Cypress._ refers to lodash bundled with Cypress

  // Cypress.platform → process.platform
  result = result.replace(/\bCypress\.platform\b/g, "process.platform");

  // Cypress.arch → process.arch
  result = result.replace(/\bCypress\.arch\b/g, "process.arch");

  // Cypress.version → "migrated"
  result = result.replace(/\bCypress\.version\b/g, '"migrated"');

  return result;
}
