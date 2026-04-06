# Refactory Tools Reference

Refactory provides 6 specialized tools to guide you through the decomposition process.

## 1. refactory_analyze
Performs an initial health check and complexity assessment.

- **Inputs**: \`path\` (string)
- **What it does**: 
  - Counts functions and lines of code.
  - Generates a basic dependency graph.
  - Identifies "hot" routines that should be extracted first.
- **Example**: *"Analyze scripts/monolith.js"*

## 2. refactory_plan
Generates a multi-module decomposition strategy.

- **Inputs**: \`path\` (string), \`num_modules\` (optional int)
- **What it does**:
  - Uses AST analysis + LLM reasoning to find logical module boundaries.
  - Defines which functions go to which new files.
  - Proposes import/export structures to avoid circular deps.
- **Example**: *"Generate a refactor plan for this file"*

## 3. refactory_extract
Performs the actual extraction of a specific module.

- **Inputs**: \`source_path\` (string), \`module_name\` (string), \`functions\` (string[])
- **What it does**:
  - Routes the request to the best available free LLM (prefers Groq for 32k output).
  - Writes the new module file with correct imports.
  - Updates the original file to re-export the extracted logic.
- **Example**: *"Extract the auth logic into lib/auth.js"*

## 4. refactory_verify
Safety gate to ensure the new structure is valid.

- **Inputs**: \`project_root\` (string)
- **What it does**:
  - Checks for syntax errors in new files (\`node --check\`).
  - Verifies all \`require()\` or \`import\` paths resolve.
  - Scans for circular dependencies.
  - Runs existing tests to ensure behavioral parity.
- **Example**: *"Verify the new structure"*

## 5. refactory_metrics
Calculates the impact of the refactor.

- **Inputs**: \`before_path\` (string), \`after_dir\` (string)
- **What it does**:
  - Compares file size and cyclomatic complexity.
  - Calculates the **Refactory Score** (0.0 - 1.0).
- **Example**: *"Show me the refactor metrics"*

## 6. refactory_report
Generates a comprehensive summary of the work.

- **Inputs**: \`output_format\` (markdown | html)
- **What it does**:
  - Summarizes changes made.
  - Includes dependency graphs (Mermaid format).
  - Lists any manual cleanup required.
- **Example**: *"Generate a refactor report"*