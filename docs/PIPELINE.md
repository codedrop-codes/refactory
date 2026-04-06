# Pipeline Reference

Refactory decomposes monoliths in 7 steps. Each step is an independent MCP tool that can be called alone or composed into the full pipeline.

## Overview

```
  ANALYZE  -->  CHARACTERIZE  -->  PLAN  -->  EXTRACT  -->  FIX-IMPORTS  -->  VERIFY  -->  METRICS
  (local)       (local)           (LLM)      (LLM)        (local)           (local)      (local)
```

Steps marked **(local)** run entirely on your machine with no API calls. Steps marked **(LLM)** route to free-tier providers.

---

## Step 1: Analyze

**Tool:** `refactory_analyze`
**Input:** `{ file, language?, deep? }`
**Output:** `{ lines, functions, functionList, health, recommendation, dependencies }`

Scans the file and produces a health assessment. Uses ast-grep for AST analysis when available, falls back to regex extraction.

**Health score components:**
- `linesScore` -- penalizes files over 300 lines, harsh above 1000
- `fnCountScore` -- penalizes files with more than 10 functions
- `fnSizeScore` -- penalizes the largest function (>50 lines = yellow, >100 = red)
- `couplingScore` -- penalizes files with many require/import statements
- `complexityScore` -- penalizes high cyclomatic complexity

**Deep mode** (`deep: true`) adds:
- Business logic flag detection (magic numbers, HACK/WORKAROUND comments, defensive null clusters)
- Consumer scanning (which files in the project require this one)
- Per-function risk ratings (low/medium/high based on DB access, HTTP calls, concurrency, error handling)

**Recommendation thresholds:**
- `ok` -- under 500 lines and health above 0.7
- `consider_decompose` -- 500-1000 lines or health 0.5-0.7
- `decompose` -- over 1000 lines or health below 0.5

---

## Step 2: Characterize

**Tool:** `refactory_characterize`
**Input:** `{ file, outputDir }`
**Output:** `{ testFile, goldenFile, exportCount, exports }`

Run this BEFORE any decomposition. It creates two files:

1. **Golden exports** (`*.golden-exports.json`) -- snapshot of every exported name and its `typeof`. This is the behavioral contract.
2. **Characterization test** (`*.characterize.test.js`) -- a `node:test` file that asserts export count, export types, and callable function arity.

After decomposition, run `refactory_verify_exports` against the golden file to catch:
- Missing exports (function was lost during extraction)
- Added exports (unexpected new exports appeared)
- Type changes (a function became an object, or vice versa)

This is how you prevent the "127 bugs introduced during refactoring" problem. If the export surface changes, you know before you commit.

---

## Step 3: Plan

**Tool:** `refactory_plan`
**Input:** `{ file, modules?, maxLines?, style? }`
**Output:** `{ modules: [{ name, description, functions, estimatedLines, dependencies }], sharedHelpers, indexExports }`

Sends a **compressed function map** to the LLM -- not the full source. The function map contains name, params, line range, and estimated size for each function. This is roughly 10x fewer tokens than full source, which means it fits in any provider's context window and costs near-zero tokens.

The LLM returns a JSON plan: which functions go in which module, estimated sizes, inter-module dependencies, shared helpers, and the list of exports to preserve in the index re-export.

**Grouping styles:**
- `functional` (default) -- group by what the functions do (DB, HTTP, validation, etc.)
- `domain` -- group by business domain (users, orders, billing, etc.)
- `layer` -- group by architectural layer (routes, services, data access, etc.)

**Provider selection:** The router picks the cheapest capable provider. Planning needs modest output (~4k tokens for the JSON) but benefits from large context if the function map is big. Gemini (1M context) is preferred for huge files; Groq is fine for most.

---

## Step 4: Extract

**Tool:** `refactory_extract`
**Input:** `{ file, module, functions?, outputDir?, plan? }`
**Output:** `{ module, outputPath, lines, provider, syntaxValid, syntaxError }`

Sends the full source + extraction instructions to the LLM. The prompt specifies which functions to extract, requires `"use strict"`, preserves exact signatures, and demands complete output (no truncation).

**Provider selection:** Extraction needs high output tokens. Groq (32k) is preferred because other free providers cap at 8-16k, which truncates modules over ~400 lines. The router checks `preferHighOutput` and routes to the LARGE_OUTPUT capability slot first.

**Post-processing:**
1. Strip markdown fences -- ~30% of LLM responses wrap code in ` ```javascript ` fences that break .js files
2. Write to disk
3. Validate syntax with `node --check`

If syntax validation fails, the error is returned in the output. The caller decides whether to retry or fix manually.

---

## Step 5: Fix Imports

**Tool:** `refactory_fix_imports`
**Input:** `{ moduleDir, projectDir?, dryRun? }`
**Output:** `{ fixed: [{ file, old, new }], errors }`

Purely mechanical -- no LLM. Runs in two phases:

**Phase 1 -- Module-internal:** Scans every `.js` file in `moduleDir` for `require()` calls with relative paths that don't resolve. For each broken require, searches `moduleDir` for a file matching the basename and rewrites the path.

**Phase 2 -- Project consumers:** Scans all `.js` files in `projectDir` (outside `moduleDir`) for `require()` calls that no longer resolve. If the target was extracted into `moduleDir`, rewrites the path to point there.

**Path resolution:** Tries the path as-is, then with `.js`, `.json`, and `/index.js` suffixes. Matches by basename when the original path structure no longer exists.

**Dry run:** Set `dryRun: true` to see what would change without writing any files.

---

## Step 6: Verify

**Tool:** `refactory_verify`
**Input:** `{ moduleDir, original?, testCmd? }`
**Output:** `{ modules: [{ file, syntax, loads, exports, syntaxError?, loadError? }], allClean, testsPassed? }`

Three checks per module:

1. **Syntax** -- `node --check` on every `.js` file in the directory
2. **Load** -- `require()` each module; catches missing dependencies, runtime errors
3. **Exports** -- enumerate `Object.keys()` of the loaded module

If `testCmd` is provided, runs it and captures output. Test failure sets `allClean: false`.

**Export comparison** (via `refactory_verify_exports`): compares the loaded module's exports against the golden snapshot from Step 2.

---

## Step 7: Metrics + Report

**Tool:** `refactory_metrics` then `refactory_report`
**Input:** `{ original, moduleDir }` then `{ metricsFile, format?, outputPath? }`
**Output:** Refactory Score + Markdown/HTML report

Metrics calculated:
- Original file: line count, function count
- Decomposed: module count, total lines, max module lines, average module lines, clean rate
- **Refactory Score** = `clean_rate * size_reduction`

The report includes all metrics in a formatted Markdown table with per-module status (OK/FAIL).

---

## Deep Mode vs Fast Mode

| Aspect | Fast (default) | Deep (`deep: true`) |
|--------|---------------|---------------------|
| Function extraction | Names, lines, signatures | + params, complexity, risk rating |
| Dependencies | Module names + lines | + which functions use each dependency |
| Business logic | Skipped | Magic numbers, flagged comments, null clusters |
| Consumers | Skipped | Scans project for files that require this one |
| Speed | ~100ms for 2000-line file | ~500ms (filesystem scan) |
| When to use | Quick health check, CI | Pre-decomposition planning |

Use fast mode for triage. Use deep mode before committing to a decomposition plan.

---

## How the Provider Router Works

For each API call: (1) check capability slots for explicit user preference, (2) filter by minimum output/context requirements, (3) try providers in priority order (Groq > Gemini > OpenRouter > SambaNova), (4) on HTTP 429, try next provider, (5) on other errors, stop.

---

## How Characterization Tests Prevent Regressions

The golden export snapshot (`*.golden-exports.json`) captures every exported name and its `typeof` as data. After decomposition, `verify_exports` diffs the new module against this snapshot. Missing exports, type changes, and unexpected additions are reported explicitly -- not discovered as mystery test failures days later.

---

## How Circular Dependency Detection Works

`refactory_depmap` builds a directed graph from all `require()`/`import` statements and runs DFS cycle detection. If A requires B and B requires A, the full cycle path is reported. The `diffDependencies` function compares pre- and post-decomposition graphs to catch orphaned requires, missing consumers, and newly introduced cycles.
