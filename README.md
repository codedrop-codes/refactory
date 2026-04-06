# Refactory

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![API Cost](https://img.shields.io/badge/API%20cost-%240-green)]()
[![Discord](https://img.shields.io/badge/Discord-join-7289da)](https://discord.gg/kPk3NmRD)

> Mechanical code decomposition. AI plans the boundaries. Deterministic extraction copies the code. Zero hallucinations.

Refactory splits monolith source files into clean modules. It uses an LLM for one thing — deciding which functions group together. Everything else is mechanical: function boundary detection, import resolution, module assembly, syntax validation, scoring.

**JavaScript and Python extraction is 100% mechanical.** No LLM tokens, no output truncation, no syntax errors. Guaranteed. Other languages fall back to LLM extraction with adaptive compression.

Works with Claude Code, Cursor, Windsurf, VS Code Copilot — any MCP client. Or use the CLI directly.

## Results

Tested against 15 production monoliths:

| Metric | Value |
|--------|-------|
| Lines decomposed | 32,736 |
| Functions extracted | 1,017 |
| Syntax validity | 100% |
| LLM tokens for extraction | 0 |
| API cost | $0 |

## Quick Start

### MCP (recommended)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "refactory": {
      "command": "npx",
      "args": ["@refactory/mcp"],
      "env": {
        "GROQ_API_KEY": "your-key-here"
      }
    }
  }
}
```

Then tell your AI tool: *"Analyze and decompose src/big-file.js into modules"*

One free API key (Groq or Gemini) is needed for the PLAN step only. Extraction is mechanical — no key required for JS/Python.

### CLI

```bash
git clone https://github.com/codedrop-codes/refactory.git
cd refactory && npm install
node src/cli.js decompose src/big-file.js
```

Other commands:
```bash
refactory analyze src/big-file.js        # Health check + function map
refactory plan src/big-file.js           # Generate module boundaries (needs LLM key)
refactory verify lib/modules/            # Check extracted modules
refactory languages                      # Show supported languages
refactory providers                      # Show configured LLM providers
refactory test submit broken.js          # Submit a file that breaks extraction
refactory test run                       # Validate preprocessors against test corpus
```

## How It Works

```
  1. ANALYZE         Scan functions, dependencies, health — mechanical
       |
  2. CHARACTERIZE    Snapshot exports before touching anything — mechanical
       |
  3. PLAN            LLM decides module boundaries — the only AI step
       |
  4. EXTRACT         Copy functions by line range, resolve imports — mechanical
       |               (LLM fallback for unsupported languages)
  5. FIX-IMPORTS     Rewrite require()/import paths — mechanical
       |
  6. VERIFY          Syntax check, load check, export comparison — mechanical
       |
  7. METRICS         Refactory Score + HTML report — mechanical
```

6 of 7 steps are deterministic. The LLM only decides *where* to split — it never touches your code.

## Language Support

| Language | Extraction | Status |
|----------|-----------|--------|
| JavaScript / TypeScript | Mechanical | Built in |
| Python | Mechanical | Built in |
| Go, Rust, Java, C#, Kotlin, Swift | Mechanical | [Pro](https://refactory.codedrop.codes) |
| Everything else | LLM with compression | Automatic fallback |

Mechanical extraction means: zero LLM tokens, instant, 100% syntax valid. The preprocessor finds function boundaries by parsing, copies them by line range, and resolves imports deterministically.

[Contribute a preprocessor](CONTRIBUTING.md) for your language.

## Refactory Score

A single number (0.0 to 1.0) that measures decomposition quality.

```
Score = clean_rate × size_reduction
```

- **clean_rate** — modules that load without errors / total modules
- **size_reduction** — 1 − (largest module / original file)

A score of **1.0** means every module loads cleanly and no module is bigger than the original.

## Provider Routing

You only need one free key for the PLAN step. Extraction is mechanical for supported languages.

| Provider | Output | Context | Free? |
|----------|--------|---------|-------|
| Groq Llama 3.3 70B | 32k | 128k | Yes |
| Gemini 2.5 Flash | 16k | 1M | Yes |
| OpenRouter Qwen 3.6+ | 16k | 1M | Yes |
| SambaNova MiniMax | 16k | 163k | Yes |

Set at least one: `GROQ_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, or `SAMBANOVA_API_KEY`.

## Test Corpus

Found a file that breaks extraction? Submit it:

```bash
refactory test submit broken-file.js -d "what went wrong"
```

Secrets are stripped automatically. Every submission becomes a permanent test case. The extractor gets stronger with every report.

[Report via GitHub](https://github.com/codedrop-codes/refactory/issues/new?template=broken-extraction.md) if you prefer.

## Community

- [Discord](https://discord.gg/kPk3NmRD) — Help, ideas, show your results
- [Discussions](https://github.com/codedrop-codes/refactory/discussions) — Feature requests, language requests
- [Issues](https://github.com/codedrop-codes/refactory/issues) — Bug reports
- [Contributing](CONTRIBUTING.md) — Build a preprocessor, submit test files

## License

AGPL-3.0 — see [LICENSE](LICENSE).

Premium language packs available under commercial license. See [refactory.codedrop.codes](https://refactory.codedrop.codes).
