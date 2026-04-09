import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli";

const createdProjects: string[] = [];

async function createProjectFromFixture(fixtureName = "enterprise-suite"): Promise<string> {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "cypw-p2-"));
  const fixtureRoot = path.resolve(__dirname, "..", "fixtures", fixtureName);
  await cp(fixtureRoot, targetRoot, { recursive: true });
  createdProjects.push(targetRoot);
  return targetRoot;
}

afterEach(async () => {
  await Promise.allSettled(createdProjects.splice(0).map((projectRoot) => import("node:fs/promises").then(({ rm }) => rm(projectRoot, { recursive: true, force: true }))));
});

describe("Phase 1-4 command coverage", () => {
  it("converts the api-mock fixture with intercept stubs, DOM traversal, and expanded assertions", async () => {
    const projectRoot = await createProjectFromFixture();
    await runCli(["convert", "--project-root", projectRoot]);

    const apiMockSpecPath = path.resolve(projectRoot, "playwright", "tests", "dashboard", "api-mock.spec.ts");
    const apiMockSpec = await readFile(apiMockSpecPath, "utf8");
    const reportPath = path.resolve(projectRoot, ".cypw", "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    // Phase 2: Intercept response stubbing → page.route() + route.fulfill()
    expect(apiMockSpec).toContain("page.route(");
    expect(apiMockSpec).toContain("route.fulfill(");
    expect(apiMockSpec).toContain("application/json");

    // Phase 1: getByTestId upgrade for data-testid selectors
    expect(apiMockSpec).toContain("page.getByTestId(");
    expect(apiMockSpec).not.toContain("page.locator(\"[data-testid=");

    // Phase 1: DOM traversal commands
    expect(apiMockSpec).toContain(".first()");
    expect(apiMockSpec).toContain(".last()");
    expect(apiMockSpec).toContain(".nth(0)");
    expect(apiMockSpec).toContain(".locator(\"> *\")");
    expect(apiMockSpec).toContain(".locator(\"..\")");

    // Phase 1: New action commands
    expect(apiMockSpec).toContain(".clear()");
    expect(apiMockSpec).toContain(".dblclick()");
    expect(apiMockSpec).toContain(".click({ button: \"right\" })");
    expect(apiMockSpec).toContain(".focus()");
    expect(apiMockSpec).toContain(".blur()");
    expect(apiMockSpec).toContain(".scrollIntoViewIfNeeded()");
    expect(apiMockSpec).toContain(".dispatchEvent(\"mouseover\")");

    // Phase 1: Expanded assertions
    expect(apiMockSpec).toContain("toHaveCount(1)");
    expect(apiMockSpec).toContain("toContainText(");
    expect(apiMockSpec).toContain("toBeDisabled()");
    expect(apiMockSpec).toContain("toBeEnabled()");
    expect(apiMockSpec).toContain("not.toBeChecked()");
    expect(apiMockSpec).toContain("toBeChecked()");
    expect(apiMockSpec).toContain("toHaveAttribute(");
    expect(apiMockSpec).toContain("toHaveClass(");
    expect(apiMockSpec).toContain("toHaveCSS(");

    // Phase 1: invoke and its commands
    expect(apiMockSpec).toContain(".textContent()");
    expect(apiMockSpec).toContain(".inputValue()");
    expect(apiMockSpec).toContain(".getAttribute(");

    // Phase 1: Navigation commands
    expect(apiMockSpec).toContain("page.url()");
    expect(apiMockSpec).toContain("page.title()");
    expect(apiMockSpec).toContain("page.reload()");
    expect(apiMockSpec).toContain("page.goBack()");
    expect(apiMockSpec).toContain("page.setViewportSize(");

    // Validation: generated output compiles
    expect(report.validation.passed).toBe(true);
  });

  it("fixture files are copied to the output tree", async () => {
    const projectRoot = await createProjectFromFixture();
    await runCli(["convert", "--project-root", projectRoot]);

    const fixturePath = path.resolve(projectRoot, "playwright", "fixtures", "data", "user.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(fixture.username).toBeDefined();
  });
});
