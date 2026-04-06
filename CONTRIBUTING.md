# Contributing to Refactory

## Ways to help

### 1. Submit files that break extraction
The fastest way to improve Refactory. Found a file that produces invalid syntax?

**Option A — CLI (easiest):**
```bash
refactory test submit yourfile.js -d "arrow functions with default destructured params"
```
This strips secrets automatically and adds it to your local test corpus.

**Option B — GitHub Issue:**
Open a [Broken Extraction](https://github.com/codedrop-codes/refactory/issues/new?template=broken-extraction.md) issue. Include the language, error output, and (if possible) the file.

Every submission becomes a permanent test case. The extractor gets stronger with every report.

### 2. Request a language
Open a [Discussion](https://github.com/codedrop-codes/refactory/discussions) with the "Language Request" template. Tell us what language, what makes it tricky, and link some example monolith files.

### 3. Build a language preprocessor
This is the highest-impact contribution. A preprocessor eliminates LLM dependency for an entire language.

**What a preprocessor does:**
```javascript
module.exports = {
  id: "rust",
  name: "Rust",
  extensions: [".rs"],
  detectFunctions(source)    // → [{ name, startLine, endLine, type }]
  detectImports(source)      // → [{ line, lineNumber, module }]
  resolveImports(fns, imps)  // → Map<funcName, importLines[]>
  assembleModule(fns, imps)  // → string (the output file)
  extractModule(source, names) // → { code, extracted, missing }
};
```

**Requirements:**
- Pure text transforms — no `fs`, no `child_process`, no network calls
- Handle the language's string literals (don't count braces inside strings)
- Handle nested functions/classes
- Handle multi-line declarations
- Test on at least 3 real files over 500 lines

See `src/languages/javascript.js` as the reference implementation.

### 4. Suggest features
[GitHub Discussions](https://github.com/codedrop-codes/refactory/discussions) or [Discord](https://discord.gg/kPk3NmRD).

## Development setup

```bash
git clone https://github.com/codedrop-codes/refactory.git
cd refactory
npm install
node src/cli.js --help
```

## Running tests

```bash
# Validate all preprocessors against the test corpus
node src/cli.js test run

# Syntax check
node --check src/languages/your-language.js

# Full pipeline test (needs a free API key for planning)
GROQ_API_KEY=xxx node src/cli.js decompose tests/fixtures/sample.js
```

## PR checklist

See the [PR template](.github/PULL_REQUEST_TEMPLATE.md) for the full checklist. The key gate: `refactory test run` must pass.

## Code of conduct

Be constructive. We're building something useful. Submissions that include test cases are 10x more helpful than bug reports without them.

## License

By contributing, you agree that your contributions will be licensed under AGPL-3.0.
