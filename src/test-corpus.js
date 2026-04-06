"use strict";

/**
 * Test corpus for hardening language preprocessors.
 *
 * Users submit files that break the mechanical extractor.
 * Every submission becomes a permanent test case.
 * The engine gets stronger with every bug report.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const CORPUS_DIR = path.join(__dirname, "..", "test-corpus");

/**
 * Strip potential secrets from source code before storing.
 * Conservative: replaces anything that looks like a key/token/password.
 */
function stripSecrets(source) {
  return source
    // API keys, tokens (long alphanumeric strings in quotes after key-like identifiers)
    .replace(/((?:api[_-]?key|token|secret|password|auth|credential|bearer)\s*[:=]\s*["'`])([^"'`]{8,})(["'`])/gi,
      "$1REDACTED$3")
    // Environment variable assignments with long values
    .replace(/((?:KEY|TOKEN|SECRET|PASSWORD|AUTH)=)(.{8,})$/gm, "$1REDACTED")
    // URLs with embedded credentials
    .replace(/(https?:\/\/)[^:]+:[^@]+@/g, "$1REDACTED:REDACTED@");
}

/**
 * Submit a file to the test corpus.
 *
 * @param {string} filePath — path to the file that breaks extraction
 * @param {string} [description] — what goes wrong
 * @returns {{ corpusPath: string, language: string }}
 */
function submit(filePath, description) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);

  const ext = path.extname(absPath).toLowerCase();
  const source = fs.readFileSync(absPath, "utf8");
  const safe = stripSecrets(source);

  // Organize by language
  const langDir = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".jsx": "javascript", ".tsx": "typescript",
    ".py": "python", ".pyw": "python",
    ".go": "go", ".rs": "rust", ".java": "java",
    ".cs": "csharp", ".kt": "kotlin", ".swift": "swift",
    ".rb": "ruby", ".php": "php",
  }[ext] || "other";

  const dir = path.join(CORPUS_DIR, langDir);
  fs.mkdirSync(dir, { recursive: true });

  // Generate unique filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const basename = path.basename(absPath, ext);
  const corpusName = `${basename}-${timestamp}${ext}`;
  const corpusPath = path.join(dir, corpusName);

  // Write the file with a header comment
  const header = `// REFACTORY TEST CORPUS SUBMISSION
// Original: ${path.basename(absPath)}
// Lines: ${source.split("\n").length}
// Submitted: ${new Date().toISOString()}
// Description: ${description || "No description provided"}
// Secrets: stripped
//
`;
  fs.writeFileSync(corpusPath, header + safe, "utf8");

  // Write metadata
  const metaPath = corpusPath + ".meta.json";
  fs.writeFileSync(metaPath, JSON.stringify({
    original: path.basename(absPath),
    language: langDir,
    lines: source.split("\n").length,
    chars: source.length,
    submitted: new Date().toISOString(),
    description: description || null,
  }, null, 2), "utf8");

  return { corpusPath, language: langDir };
}

/**
 * Run the full test corpus against all preprocessors.
 * Returns pass/fail for each file.
 */
function runCorpus() {
  const { getPreprocessor } = require("./languages");

  if (!fs.existsSync(CORPUS_DIR)) {
    return { total: 0, passed: 0, failed: 0, results: [] };
  }

  const results = [];
  const langDirs = fs.readdirSync(CORPUS_DIR).filter(d =>
    fs.statSync(path.join(CORPUS_DIR, d)).isDirectory()
  );

  for (const langDir of langDirs) {
    const dir = path.join(CORPUS_DIR, langDir);
    const files = fs.readdirSync(dir).filter(f => !f.endsWith(".meta.json"));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const preprocessor = getPreprocessor(filePath);

      if (!preprocessor) {
        results.push({ file, language: langDir, status: "skip", reason: "no preprocessor" });
        continue;
      }

      try {
        const source = fs.readFileSync(filePath, "utf8");
        const funcs = preprocessor.detectFunctions(source);

        if (funcs.length === 0) {
          results.push({ file, language: langDir, status: "skip", reason: "no functions detected" });
          continue;
        }

        // Extract all functions into a single module and syntax-check
        const allNames = funcs.map(f => f.name);
        const extracted = preprocessor.extractModule(source, allNames);

        const tmpFile = path.join("/tmp", `corpus-test-${file}`);
        fs.writeFileSync(tmpFile, extracted.code, "utf8");

        try {
          execSync(`node --check "${tmpFile}"`, { stdio: "pipe", timeout: 10000 });
          results.push({
            file, language: langDir, status: "pass",
            functions: funcs.length, extracted: extracted.extracted.length, missing: extracted.missing.length,
          });
        } catch (e) {
          const error = e.stderr ? e.stderr.toString().split("\n")[0] : "unknown";
          results.push({ file, language: langDir, status: "fail", error, functions: funcs.length });
        }

        try { fs.unlinkSync(tmpFile); } catch {}
      } catch (err) {
        results.push({ file, language: langDir, status: "error", error: err.message });
      }
    }
  }

  const passed = results.filter(r => r.status === "pass").length;
  const failed = results.filter(r => r.status === "fail").length;
  const errors = results.filter(r => r.status === "error").length;
  const skipped = results.filter(r => r.status === "skip").length;

  return { total: results.length, passed, failed, errors, skipped, results };
}

module.exports = { submit, runCorpus, stripSecrets, CORPUS_DIR };
