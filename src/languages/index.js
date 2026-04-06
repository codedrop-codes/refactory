"use strict";

/**
 * Language preprocessor registry.
 *
 * Each preprocessor provides mechanical function extraction for a specific
 * language. When available, extraction is 100% syntax-valid with zero LLM
 * tokens. Languages without a preprocessor fall back to LLM extraction.
 *
 * To add a new language, create a file in this directory that exports:
 *
 *   {
 *     id:         "python",
 *     name:       "Python",
 *     extensions: [".py"],
 *     detectFunctions(source)  → [{ name, startLine, endLine, type, async }]
 *     detectImports(source)    → [{ line, lineNumber, modules }]
 *     resolveImports(functions, imports, source) → Map<funcName, importLines[]>
 *     assembleModule(funcBodies, importLines, options) → string
 *   }
 *
 * Then register it in the LANGUAGES array below.
 *
 * Community contributions welcome — see CONTRIBUTING.md for the test harness.
 */

const javascript = require("./javascript");
const python = require("./python");

const LANGUAGES = [javascript, python];

const byExtension = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    byExtension.set(ext, lang);
  }
}

function getPreprocessor(filePath) {
  const path = require("node:path");
  const ext = path.extname(filePath).toLowerCase();
  return byExtension.get(ext) || null;
}

function listLanguages() {
  return LANGUAGES.map((l) => ({ id: l.id, name: l.name, extensions: l.extensions }));
}

module.exports = { getPreprocessor, listLanguages, LANGUAGES };
