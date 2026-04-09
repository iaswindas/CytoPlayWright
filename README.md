# cypw

`cypw` is an offline-first migration compiler that analyzes and converts enterprise Cypress TypeScript E2E suites into side-by-side Playwright Test output. It operates safely without modifying your source files, generating a separate `playwright` directory within your chosen project root.

## Quick Start (Running Against Your Automation Suite)

You do **not** need to place this repository inside your automation suite. Keep `CytoPlayWright` as its own separate folder.

**1. Build & Link the Compiler Globally**
In the `CytoPlayWright` repository directory, run:
```bash
npm install
npm run build
npm link
```
*This installs dependencies, compiles the TS to JS, and securely links the `cypw` CLI command to your global system path.*

**2. Navigate to your Automation Suite**
Open your terminal and navigate to the root directory of your active Cypress automation test suite:
```bash
cd /path/to/your/automation-suite
```

**3. Run the Migration**
Execute the toolkit sequentially against your suite:
```bash
# Generate the default configuration file for the compiler
cypw init

# Scan the Cypress folders and provide an intelligence readiness score/report without translating
cypw analyze

# Execute the compiler. Generates the new Playwright architecture side-by-side!
cypw convert

# Validate TypeScript type-checking on the newly generated output
cypw validate
```

## Configuration

When you run `cypw init`, a `cypw.config.jsonc` file is created at the root of your target project. You can modify this to change where it looks for Cypress files (e.g., `"sourceRoots": ["cypress"]`) and where it deposits the new tests (e.g., `"outputRoot": "playwright"`).

## Development

```bash
npm test
```
