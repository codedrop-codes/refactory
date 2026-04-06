# Refactory Development Guide

**Author:** Infinity.claude | **Date:** 2026-04-05
**Purpose:** Everything a new developer/hive needs to build Refactory without repeating our mistakes.

## The Origin Story (Read This First)

Refactory was born from a real session where we decomposed 20,710 lines across 5 monoliths at $0 API cost. The design isn't theoretical — every decision comes from hitting a wall and finding a better path.

## What We Tried and Why It Failed

### Attempt 1: CLI Agents (Codex, Gemini, Qwen)
**Result:** Hours of work, zero commits.
- Agents burn context analyzing files instead of writing code
- Approval prompts on every file write kill momentum
- Agents go off-task (Gemini did skills research instead of extracting modules)
- Branch conflicts when multiple agents share a worktree
- **Lesson: CLI agents are wrong for bulk mechanical extraction**

### Attempt 2: Free API Generation (Gemini Flash, Qwen 3.6 Plus)
**Result:** 70% of modules generated in ~15 minutes, $0.
- Gemini Flash (free): great for small modules, hits 16k output token limit on large ones
- Qwen 3.6 Plus via OpenRouter (free, 1M context): good quality but rate limited at ~3 requests before cooldown
- **Lesson: Free APIs work great for small-medium functions. Large modules get truncated.**

### Attempt 3: Subagents (Claude Code internal)
**Result:** 100% of remaining modules, ~5 min each, parallel.
- Fresh context per module — no drift, no distraction
- Read full monolith source + write complete extracted module
- No approval prompts
- **Lesson: Subagents are the sweet spot for complex module extraction**

### The Winning Pipeline
```
1. Free API (Groq 32k) → generate smaller modules
2. Subagents → handle large/complex modules that exceed output limits
3. Coordinator (me) → wire thin re-exports, fix imports, run tests
4. CLI agents → validation only (test running, export checking)
```

## Architecture Decisions

### Why MCP (not CLI-only)
- MCP works inside Claude Code, Cursor, Windsurf, VS Code — instant distribution
- The AI agent calls our tools naturally, no separate workflow to learn
- `npx @refactory/mcp` in .mcp.json = zero-install experience
- CLI is a secondary interface for CI/scripting

### Why BYOK (Bring Your Own Keys)
- We proved $0 decomposition using free tiers (Groq, Gemini, OpenRouter)
- Users don't need to pay us for API access — they already have keys
- Our value is the *routing intelligence*, not the API access
- Paid tier adds hosted backend with premium models + dashboard

### Why Provider Router with Fallback
The router selects providers in this order (all free):

| Priority | Provider | Output Limit | Context | Best For |
|----------|----------|-------------|---------|----------|
| 1 | Groq Llama 3.3 70B | **32k** | 128k | Large module extraction |
| 2 | Gemini 2.5 Flash | 16k | **1M** | Planning, small modules |
| 3 | OpenRouter Qwen 3.6+ | 16k | **1M** | Backup, rate limit overflow |
| 4 | SambaNova MiniMax | 16k | 163k | Last resort |

**Why Groq first:** 32k output tokens is the key. Other free providers cap at 8-16k, which truncates modules over ~400 lines. Groq's 32k handles modules up to ~1000 lines cleanly.

**Fallback chain:** On 429 (rate limit), automatically try next provider. On other errors, stop. This gives resilience without wasting time on broken providers.

### Why Refactory Score
```
Score = clean_rate × size_reduction × test_preservation × health_improvement
```
- Gives users a single number to evaluate decomposition quality
- 1.0 = perfect, anything less tells you what degraded
- This is the marketing differentiator — no other tool measures decomposition quality

## Common Failure Modes (and How We Handle Them)

### 1. Output Truncation
**Problem:** Free APIs cap output at 8-16k tokens. A 600-line module = ~12k tokens = gets cut off.
**Solution:** Route large extractions to Groq (32k). If still too large, split the extraction into 2 calls.

### 2. Markdown Fences in Output
**Problem:** LLMs wrap code in \`\`\`javascript fences. If you write that to a .js file, it won't parse.
**Solution:** Always strip markdown fences from API output before writing:
```js
const codeMatch = response.match(/```(?:javascript|js)\n([\s\S]*?)```/);
const code = codeMatch ? codeMatch[1].trim() : response.trim();
```

### 3. Template Literals with ${}
**Problem:** When the LLM generates code containing `${var}`, some API responses mangle the backticks or escaping.
**Solution:** Validate with `node --check <file>` after every write. If syntax error on a template literal line, regenerate that module.

### 4. Import Path Errors
**Problem:** Extracted module requires `./foo` but foo is now at `../lib/foo`.
**Solution:** After extraction, run ast-grep to verify all require() paths resolve. The verify tool checks this.

### 5. Missing Cross-Module Functions
**Problem:** Module A calls functionX, but functionX was extracted into Module B, and Module A doesn't require Module B.
**Solution:** The plan tool must generate a dependency graph. The extract tool must include the right requires based on that graph.

### 6. Circular Dependencies
**Problem:** Module A requires Module B, Module B requires Module A.
**Solution:** The verify tool checks for circular deps. If found, the shared functions need to be extracted into a third module.

### 7. Dropped async/await
**Problem:** LLM copies function body but forgets to mark it async or drops await on db calls.
**Solution:** If the original function was async, the prompt must explicitly state "this function is async — preserve await on all db calls."

### 8. Hidden Business Logic Removed
**Problem:** LLM "simplifies" a function by removing a null check that guards a real edge case.
**Solution:** Characterization tests BEFORE decomposition. Compare outputs before/after. We don't have this yet — it's a v0.2 feature.

## What to Build Next (Priority Order)

### v0.1 → v0.2 (Make It Work)
1. **Install MCP SDK dependency** — `npm i @modelcontextprotocol/sdk`
2. **Test MCP server locally** — connect to Claude Code via .mcp.json
3. **Flesh out analyze tool** — integrate ast-grep for real AST analysis
4. **Add CLI entry point** — `refactory analyze <file>` for non-MCP usage
5. **Test on production monoliths** — real-world validation

### v0.3 (Make It Reliable)
6. **Characterization tests** — auto-generate before decomposition
7. **ast-grep import rewriting** — mechanical post-extraction path fixing
8. **Dependency graph** — generate before AND after, diff for circular deps
9. **Multi-proposal generation** — ask for 5 plans, pick best (29% better test pass rate)

### v0.5 (Make It Measurable)
10. **Refactory Score calibration** — test against 20+ real codebases
11. **Static HTML report** — single file with Mermaid dependency graphs
12. **CI integration** — GitHub Action that runs on PR and comments score

### v1.0 (Make It Public)
13. **Documentation polish** — tutorials, examples, video demo
14. **Case studies** — our 5 monolith decompositions with before/after metrics
15. **npm publish** — `npx @refactory/mcp` just works
16. **Hosted tier** — API key for premium models + dashboard

## Testing Strategy

### Unit Tests
Each tool gets its own test file in `tests/`:
- `tests/analyze.test.js` — test with known files of various sizes
- `tests/plan.test.js` — mock the API response, verify plan JSON structure
- `tests/extract.test.js` — mock API, verify file writing + fence stripping
- `tests/verify.test.js` — test with intentionally broken modules
- `tests/metrics.test.js` — test score calculation with known inputs
- `tests/report.test.js` — verify Markdown output format

### Integration Tests
- Full pipeline: analyze → plan → extract → verify → metrics → report
- Use a small test monolith (~200 lines, 5 functions) committed in `tests/fixtures/`
- Test with real APIs (tagged as `@slow`, skipped in CI without keys)

### Regression Tests
- The test corpus serves as golden references
- Run `refactory test run` to validate all preprocessors against the corpus

## Key Files

```
refactory/
├── src/
│   ├── server.js           — MCP server (tool registration + dispatch)
│   ├── cli.js              — CLI entry point (TODO)
│   ├── tools/
│   │   ├── analyze.js      — file health assessment
│   │   ├── plan.js         — module boundary generation
│   │   ├── extract.js      — single module extraction
│   │   ├── verify.js       — post-extraction validation
│   │   ├── metrics.js      — before/after scoring
│   │   └── report.js       — Markdown/HTML report generation
│   └── providers/
│       └── router.js       — multi-provider LLM routing with fallback
├── tests/
│   └── fixtures/           — test monoliths (TODO)
├── docs/
│   └── DEVELOPMENT_GUIDE.md — this file
├── package.json
├── README.md
├── LICENSE
└── .gitignore
```

## Environment Variables

```bash
# At least one required:
GROQ_API_KEY=...           # Best: 32k output, free
GOOGLE_API_KEY=...         # Good: 1M context, free
OPENROUTER_API_KEY=...     # Good: Qwen 3.6 free tier
SAMBANOVA_API_KEY=...      # OK: 163k context

# Optional (second keys for rate limit resilience):
GROQ_API_KEY_2=...
```

## Standing Rules

1. **Never hardcode API keys** — always read from env
2. **Always strip markdown fences** from API output before writing files
3. **Always validate with `node --check`** after writing any .js file
4. **Groq first** for extraction (32k output) — other providers truncate
5. **Document WHY** in code comments, not just WHAT
6. **Test on real codebases** — toy examples miss the hard problems
7. **The Refactory Score must be honest** — if decomposition degraded something, the score must reflect it
