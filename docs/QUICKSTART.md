# Refactory Quickstart

Zero to decomposed modules in 5 minutes.

## 1. Get a free API key (30 seconds)

Go to https://console.groq.com/keys → sign up → Create API Key → copy it.

See [GET-API-KEYS.md](GET-API-KEYS.md) for other providers, but Groq is the best starting point (32k output, free).

## 2. Set your key

```bash
export GROQ_API_KEY=gsk_your_key_here
```

## 3. Decompose a file

### Option A: One command (CLI)

```bash
npx @refactory/mcp decompose src/big-file.js
```

That's it. Refactory will:
- Analyze the file (health, functions, dependencies)
- Snapshot exports (so you can verify nothing breaks)
- Plan module boundaries (via free LLM)
- Extract each module
- Fix import paths
- Verify everything loads
- Generate a report with Refactory Score

### Option B: MCP (inside Claude Code, Cursor, etc.)

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "refactory": {
      "command": "npx",
      "args": ["@refactory/mcp"],
      "env": { "GROQ_API_KEY": "gsk_your_key_here" }
    }
  }
}
```

Then just say: *"Decompose src/big-file.js into modules"*

## 4. Read the output

```
Refactory: analyzing big-file.js (3200 lines, 45 functions)
Refactory: planning decomposition... 12 modules via groq
Refactory: extracting [1/12] utils.js... 180L OK
Refactory: extracting [2/12] db.js... 340L OK
...
Refactory: verifying 12 modules... 11/12 clean
Refactory: Score 0.92 | 12 modules | 92% clean | report: lib/big-file/REPORT.md
```

The report includes Mermaid diagrams showing the pipeline flow and module graph.

## 5. If something fails

| Problem | Fix |
|---------|-----|
| Module has syntax error | Large modules hit output limits. Set `GROQ_API_KEY` (32k output) instead of Gemini (16k) |
| "No API keys configured" | `export GROQ_API_KEY=...` — see [GET-API-KEYS.md](GET-API-KEYS.md) |
| Rate limited | Add a second provider key. The router falls back automatically |
| Original file runs on require | Normal for CLI scripts. Characterize step handles it gracefully |

## Next steps

- [PIPELINE.md](PIPELINE.md) — detailed 7-step reference
- [GET-API-KEYS.md](GET-API-KEYS.md) — all free providers with setup steps
- [../README.md](../README.md) — full tool reference
