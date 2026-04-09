# cypw Gap Analysis & Next Implementation Plan

## Current State Summary

The **cypw** compiler is an impressive offline-first Cypress→Playwright migration tool with a **well-architected pipeline**:

```mermaid
graph LR
    A["Discovery"] --> B["Analysis"]
    B --> C["IR Transform"]
    C --> D["Code Generation"]
    D --> E["Validation"]
    E --> F["Reporting"]
```

**What's working well:**
- ✅ Full pipeline: `init → analyze → convert → validate` with CLI
- ✅ Intermediate Representation (IR) architecture for clean separation
- ✅ Plugin system with `detectFile`, `translateCommand`, `translateRuntimeRecipe`, `postGenerate` hooks
- ✅ Page Object Model conversion with constructor `page` injection
- ✅ Helper/utility file transformation with `Page` parameter injection
- ✅ Alias system (locator, value, intercept) with hoisting across hook/test boundaries
- ✅ Control flow: `then()`, `within()`, `each()` callback lowering
- ✅ CommonJS → ESM rewriting for helpers
- ✅ JS → TS compile-safe conversion with explicit `any` fallbacks
- ✅ `cy.window().then()` runtime recipe lowering for SpreadJS patterns
- ✅ External module shims (`types/external-modules.d.ts`)
- ✅ Validation via ts-morph type-checking, markdown reporting, handoff.json
- ✅ Project dependency graph
- ✅ 5/5 integration tests passing

---

## GAP ANALYSIS

### 🔴 Critical Gaps (Business Case Risk)

#### 1. Missing Cypress Command Coverage

The following commonly-used Cypress commands have **no direct transform mapping** and will silently fall to the "custom-command" catch-all (which throws/marks manual review):

| Missing Command | Cypress Usage | Playwright Equivalent | Files Affected |
|---|---|---|---|
| `cy.clear()` | Clear input fields | `locator.clear()` | Any form spec |
| `cy.scrollTo()` / `.scrollIntoView()` | Scroll control | `locator.scrollIntoViewIfNeeded()` | Dashboard specs |
| `cy.focused()` | Active element | `page.locator(':focus')` | Accessibility specs |
| `cy.reload()` | Page reload | `page.reload()` | Session specs |
| `cy.go('back'/'forward')` | Navigation | `page.goBack()` / `page.goForward()` | Multi-page flows |
| `cy.url()` / `cy.location()` | URL assertion | `page.url()` / `expect(page).toHaveURL()` | Navigation specs |
| `cy.title()` | Title assertion | `expect(page).toHaveTitle()` | SEO specs |
| `cy.viewport()` | Viewport sizing | `page.setViewportSize()` | Responsive specs |
| `.trigger()` | Custom DOM events | `locator.dispatchEvent()` | Drag-drop specs |
| `.invoke()` | jQuery property access | `locator.evaluate()` | Data extraction |
| `.its()` | Property chaining | Direct property access | Response handling |
| `.first()` / `.last()` / `.eq()` | Collection indexing | `.first()` / `.last()` / `.nth()` | List specs |
| `.parent()` / `.children()` / `.siblings()` | DOM traversal | `locator('..')` / `locator('> *')` | Tree specs |
| `.prev()` / `.next()` | Sibling traversal | XPath or structure-based locator | Navigation |
| `.dblclick()` / `.rightclick()` | Mouse actions | `locator.dblclick()` / `locator.click({button: 'right'})` | Context menus |
| `.focus()` / `.blur()` | Focus management | `locator.focus()` / `locator.blur()` | Forms |
| `cy.clock()` / `cy.tick()` | Time manipulation | `page.clock` API | Timer-dependent tests |
| `cy.stub()` / `cy.spy()` | Test doubles | Playwright route mocking or evaluate | Event tests |
| `.hover()` (via trigger) | Mouse hover | `locator.hover()` | Tooltips |

> [!CAUTION]
> Without these, a real enterprise suite with 200+ specs will produce a high volume of `// TODO(cypw)` markers, significantly reducing the readiness score and requiring extensive manual cleanup.

---

#### 2. Incomplete Assertion (`should()`) Mapping

Currently only **5 matchers** are handled in [translateShouldAssertion](file:///f:/cypw/src/transforms/cypress-command-transformer.ts#L317-L356):

```
be.visible, exist, not.exist, contain, contain.text, have.text, have.value
```

**Missing enterprise-critical matchers:**

| Matcher | Playwright Mapping |
|---|---|
| `be.disabled` / `be.enabled` | `toBeDisabled()` / `toBeEnabled()` |
| `be.checked` | `toBeChecked()` |
| `be.hidden` / `not.be.visible` | `toBeHidden()` |
| `be.empty` | `toBeEmpty()` |
| `have.length` | `toHaveCount()` |
| `have.attr` | `toHaveAttribute()` |
| `have.class` | `toHaveClass()` |
| `have.css` | `toHaveCSS()` |
| `have.prop` | `evaluate + expect` |
| `include` / `match` | `toContainText()` / regex matching |
| `be.selected` | `.isChecked()` or evaluate |
| `not.contain` | `not.toContainText()` |
| `not.have.class` | `not.toHaveClass()` |
| `have.id` | `toHaveId()` |
| `have.data` | `toHaveAttribute('data-*')` |

> [!IMPORTANT]
> Unsupported matchers generate a fallback `toBeVisible()` assertion which silently changes test semantics — a **correctness bug** in automated conversion.

---

#### 3. No `cy.session()` / `cy.origin()` Translation Strategy

These are marked as `UNSUPPORTED_COMMANDS` in [analyze-project.ts#L36](file:///f:/cypw/src/analysis/analyze-project.ts#L36) with no conversion path:

- **`cy.session()`** → Playwright has [`storageState`](https://playwright.dev/docs/auth) and `browser.newContext()` with auth state
- **`cy.origin()`** → Playwright natively supports multi-origin via `page.goto()` (no same-origin restriction)

These are heavily used in enterprise auth flows and SSO integrations.

---

#### 4. No `cy.intercept()` Route Handler / Response Stubbing

The current intercept translation generates a `page.waitForResponse()` matcher, but doesn't handle:
- **Response stubbing** (`cy.intercept('GET', '/api', { fixture: 'data.json' })`) → `page.route()` + `route.fulfill()`
- **Request modification** → `route.continue({ headers })`
- **Conditional routing** → `page.route()` with handler functions
- **`routeHandler` callbacks** in intercept config

> [!WARNING]
> API mocking via `cy.intercept()` is the **#1 pattern in enterprise E2E suites**. The current implementation only handles the "wait for response" use case, not the "mock/stub" use case.

---

#### 5. No `Cypress.env()` / Environment Variable Translation

Many enterprise suites use `Cypress.env('API_KEY')` extensively. There is no translation to Playwright's `process.env` or `test.use()` configuration.

---

#### 6. No Fixture File Copying/Transform

The pipeline discovers fixture files but **never copies them** to the output directory. The generated `loadFixture()` function reads from `cypress/fixtures/` directly, which:
- Breaks if the output tree is deployed separately
- Doesn't handle relative paths correctly in all project structures

---

### 🟡 Significant Gaps (Architecture & Modernization)

#### 7. No Playwright Fixture Pattern (Modern Architecture)

The generated `baseTest.ts` uses a flat `test.extend<{}>()` with `migrationState`, `loadFixture`, and `runTask`. This misses Playwright's powerful fixture composition:

- **No test fixture factories** for shared setup (e.g., `authenticatedPage`, `adminContext`)
- **No worker-scoped fixtures** for expensive setup (DB seeding, API tokens)
- **No automatic fixture cleanup** — Playwright fixtures have built-in teardown via `use()`
- **No `APIRequestContext` fixture** for API testing

---

#### 8. Missing `playwright.config.ts` Sophistication

The generated [config template](file:///f:/cypw/src/generation/templates.ts#L121-L147) is minimal. Enterprise needs:

- Multiple browser projects (Chromium, Firefox, WebKit)
- `webServer` config for dev server auto-start
- Custom `globalSetup` / `globalTeardown` for DB/auth
- Environment-specific base URLs via `.env` files
- `testMatch` patterns matching the source spec structure
- `outputDir` for test results (screenshots, videos, traces)
- `workers` configuration for CI parallelism
- `forbidOnly` and `maxFailures` for CI safety

---

#### 9. No `test.step()` Usage

Playwright's `test.step()` provides structured test reporting. The converter should wrap logical sections (e.g., each Cypress chain group) in steps for better trace/report readability.

---

#### 10. Missing Network Mocking Utilities

Beyond intercept, enterprise suites need:
- `page.route()` abstractions for API mocking
- `page.unroute()` for cleanup
- HAR-based mocking (`page.routeFromHAR()`)
- GraphQL-aware route matching

---

#### 11. No `data-testid` / Custom Locator Strategy Translation

Cypress `cy.get('[data-testid="foo"]')` is translated to `page.locator('[data-testid="foo"]')` which works, but misses the opportunity to upgrade to Playwright's semantic locators:
- `page.getByTestId('foo')` (requires `testIdAttribute` config)
- `page.getByRole()`, `page.getByLabel()`, `page.getByPlaceholder()`

---

#### 12. No Retry/Auto-Wait Annotation

Cypress has implicit retry-ability. The converter should annotate or configure:
- `expect.toPass()` for custom retries
- `expect.poll()` for async value assertions
- `locator.waitFor()` for visibility/attachment conditions

---

#### 13. Unit Tests Missing

There are **zero unit tests** — only 1 integration test file. The transform layer has 1500+ lines of complex AST logic that should have granular unit coverage for:
- Individual command transformers
- Assertion mapping
- Alias hoisting logic
- Import rewriting
- Control flow lowering

---

#### 14. No Incremental / Differential Conversion

`generateProject()` calls `emptyDirectory(outputRoot)` every time. Enterprise teams need:
- Incremental conversion (only changed files)
- Diffing previous output vs new output
- Preserving manual edits in generated files

---

### 🟢 Optimization Opportunities

#### 15. `strict: false` in tsconfig

The compiler and generated output both use `strict: false`. Moving to `strict: true` would catch more issues during both compilation and validation.

#### 16. Plugin System is `require()` Only

[load-plugins.ts](file:///f:/cypw/src/plugins/load-plugins.ts) uses `require()` which doesn't support ESM plugins.

#### 17. No Progress/Logging System

The CLI has no structured logging, progress bars, or verbosity levels for large suites.

#### 18. `for..of` Chain Iteration Has O(n²) Potential

The chain parsing in [tryParseCypressChain](file:///f:/cypw/src/transforms/cypress-command-transformer.ts#L155-L178) builds arrays via spread in recursion.

#### 19. No Watch Mode for Development

No file watcher for live re-conversion during migration development.

---

## PROPOSED IMPLEMENTATION PLAN

### Phase 1: Complete Command & Assertion Coverage (Priority: Critical)

> Directly increases readiness score and reduces `TODO(cypw)` markers for any real suite.

#### [MODIFY] [cypress-command-transformer.ts](file:///f:/cypw/src/transforms/cypress-command-transformer.ts)

- Add `lowerRootCommand` cases for: `url`, `location`, `title`, `focused`, `reload`, `go`, `viewport`, `clock`, `tick`
- Add chained command cases in `lowerCommandChain` for: `clear`, `scrollIntoView`, `trigger`, `invoke`, `its`, `first`, `last`, `eq`, `parent`, `children`, `siblings`, `next`, `prev`, `dblclick`, `rightclick`, `focus`, `blur`, `hover`
- Expand `translateShouldAssertion` to cover all 20+ matchers listed above with correct Playwright `expect` mappings
- Add negation support (`not.be.visible`, `not.contain`, etc.)

#### [MODIFY] [analyze-project.ts](file:///f:/cypw/src/analysis/analyze-project.ts)

- Move newly supported commands from `UNSUPPORTED_COMMANDS` or implicit "custom" to `SUPPORTED_COMMANDS`
- Add command-kind classification to `CONTROL_FLOW_PATTERN_MAP` as needed

#### [NEW] `tests/unit/assertion-mapping.test.ts`
#### [NEW] `tests/unit/command-transform.test.ts`

- Unit tests for each command and assertion mapping

---

### Phase 2: Network Mocking & Intercept Parity (Priority: Critical)

#### [MODIFY] [cypress-command-transformer.ts](file:///f:/cypw/src/transforms/cypress-command-transformer.ts)

- Detect intercept calls with response body/fixture → generate `page.route()` + `route.fulfill()`
- Handle `cy.intercept('GET', '/api', { statusCode: 404, body: {} })` pattern
- Handle `cy.intercept()` with `routeHandler` callback → `page.route(url, async route => { ... })`
- Generate cleanup via `page.unroute()` in afterEach if needed

#### [MODIFY] [templates.ts](file:///f:/cypw/src/generation/templates.ts)

- Add `mockRoute()` and `stubResponse()` utilities to `baseTest.ts`
- Add `registerRouteAlias()` for named route tracking

#### [NEW] `tests/fixtures/enterprise-suite/cypress/e2e/dashboard/api-mock.spec.ts`

- Test fixture exercising intercept-with-stub patterns

---

### Phase 3: Modern Playwright Features (Priority: High)

#### [MODIFY] [codegen.ts](file:///f:/cypw/src/generation/codegen.ts)

- Wrap test body sections in `test.step('description', async () => { ... })` when converting logical groups
- Detect `cy.get('[data-testid="x"]')` → emit `page.getByTestId('x')` when pattern is clean

#### [MODIFY] [templates.ts](file:///f:/cypw/src/generation/templates.ts)

- Generate richer `playwright.config.ts`:
  - Multi-browser projects
  - `webServer` placeholder
  - `globalSetup` / `globalTeardown` stubs
  - env-based `baseURL`
  - CI-tuned worker/retry settings
- Extend `baseTest.ts` fixtures:
  - Add worker-scoped `authenticatedPage` fixture pattern
  - Add `apiContext` fixture for `APIRequestContext`
  - Add proper fixture teardown patterns

#### [NEW] `src/transforms/env-transform.ts`

- Translate `Cypress.env('KEY')` → `process.env.KEY`
- Translate `Cypress.config('baseUrl')` → config reference

#### [MODIFY] [config/types.ts](file:///f:/cypw/src/config/types.ts)

- Add `locatorStrategy` config: `'css'` | `'testid'` | `'semantic'`
- Add `envMapping` config for `Cypress.env()` → `process.env` key mapping
- Add `playwrightConfig` overrides section

---

### Phase 4: Session, Origin & Auth Translation (Priority: High)

#### [NEW] `src/transforms/session-transformer.ts`

- Translate `cy.session('name', setup, { validate })` → Playwright `storageState` pattern:
  - Generate `globalSetup` auth script
  - Generate `test.use({ storageState: '.auth/name.json' })`
  - Wire `validate` callback to a re-auth check

#### [NEW] `src/transforms/origin-transformer.ts`

- Translate `cy.origin('https://other.com', () => { ... })` → direct `page.goto()` (Playwright has no same-origin restriction)

#### [MODIFY] [analyze-project.ts](file:///f:/cypw/src/analysis/analyze-project.ts)

- Move `session` and `origin` from `UNSUPPORTED_COMMANDS` to supported with strategy mappings

---

### Phase 5: Testing, Resilience & Developer Experience (Priority: Medium)

#### [NEW] `tests/unit/spec-to-ir.test.ts`
#### [NEW] `tests/unit/helper-transformer.test.ts`
#### [NEW] `tests/unit/page-object-transformer.test.ts`
#### [NEW] `tests/unit/codegen.test.ts`
#### [NEW] `tests/unit/path-resolution.test.ts`

- Granular unit tests for each transform module

#### [MODIFY] [generate-project.ts](file:///f:/cypw/src/generation/generate-project.ts)

- Add incremental mode: hash source files, skip unchanged
- Copy fixture files to output tree
- Generate migration summary diff file

#### [NEW] `src/shared/logger.ts`

- Structured logger with verbosity levels (`--verbose`, `--quiet`)
- Progress reporting for large suites

#### [MODIFY] [load-plugins.ts](file:///f:/cypw/src/plugins/load-plugins.ts)

- Support ESM plugins via `import()` instead of `require()`

#### [MODIFY] [tsconfig.json](file:///f:/cypw/tsconfig.json)

- Enable `strict: true` for better type safety

---

## Open Questions

> [!IMPORTANT]
> **Which phases should we prioritize first?** Phase 1 (command/assertion coverage) provides the highest immediate value for real-world suites. Phase 2 (network mocking) is the second highest impact. Should we start with both, or one at a time?

> [!IMPORTANT]
> **Locator upgrade strategy**: Should the converter default to `page.getByTestId()` for `[data-testid="x"]` patterns, or keep `page.locator()` for maximum fidelity? This affects test readability vs. migration safety.

> [!IMPORTANT]
> **Fixture file handling**: Should generated output be self-contained (copy fixtures into output tree), or reference the original Cypress fixture path? This affects deployment and CI integration.

---

## Verification Plan

### Automated Tests
- Each phase adds dedicated unit tests for new transforms
- Integration test assertions are extended for each new command/assertion mapping
- All tests pass with `npm test` — current: 5/5 passing
- Generated output passes ts-morph validation (already tested)

### Manual Verification
- Run converter against a real enterprise Cypress suite (200+ specs) and measure:
  - Readiness score improvement
  - Reduction in `TODO(cypw)` count
  - TypeScript compilation success rate of generated output
