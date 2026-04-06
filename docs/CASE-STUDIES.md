# Refactory Case Studies

Real decompositions from production codebases.

## Case 1: Message Broker (5,207 lines → 17 modules)

**What it was:** A monolithic message processing system handling routing, task lifecycle, queue management, database schema, CLI parsing, and event hooks — all in one file.

**The problem:** The file was too large for any single developer to hold in their head. Bug fixes required reading thousands of lines of unrelated logic. New team members avoided touching it entirely.

**What Refactory produced:**
| Module | Lines | Purpose |
|--------|-------|---------|
| utils.js | 244 | Shared utilities + helpers |
| db-core.js | 171 | Database connection + basic operations |
| db-schema.js | 448 | Schema creation + migrations |
| config-args.js | 338 | CLI argument parsing + config |
| message-processing.js | 471 | Message routing + transformation |
| routing-auth.js | 124 | Authentication + authorization |
| task-lifecycle.js | 107 | Task state management |
| commands-query.js | 416 | Read + search commands |
| commands-actions.js | 289 | Write + mutation commands |
| commands-cleanup.js | 230 | Purge + archive commands |
| queue-basic.js | 321 | Queue CRUD |
| queue-kpi.js | 320 | Queue metrics + reporting |
| observer-hooks.js | 238 | Checkpoint + validation hooks |
| event-hooks.js | 660 | Event capture + processing |
| commands-misc.js | 134 | Utility commands |
| main.js | 257 | CLI entry point |
| index.js | — | Re-exports |

**Refactory Score:** 0.89
**Extraction:** mechanical/javascript (<1 second for all 17 modules)
**Planning:** Gemini Flash free tier (49 seconds)
**API cost:** $0

---

## Tested Against 15 Production Monoliths

| File | Lines | Functions | Syntax Valid | Extraction |
|------|-------|-----------|-------------|------------|
| message-broker.js | 5,207 | 154 | PASS | mechanical |
| data-store.js | 3,183 | 147 | PASS | mechanical |
| search-engine.js | 2,687 | 70 | PASS | mechanical |
| task-dispatcher.js | 2,649 | 61 | PASS | mechanical |
| audit-system.js | 2,140 | 59 | PASS | mechanical |
| report-generator.js | 2,119 | 73 | PASS | mechanical |
| api-gateway.js | 1,989 | 1 | PASS | mechanical |
| scheduler.js | 1,952 | 65 | PASS | mechanical |
| orchestrator.js | 1,934 | 78 | PASS | mechanical |
| relay-server.js | 1,719 | 74 | PASS | mechanical |
| config-manager.js | 1,562 | 57 | PASS | mechanical |
| consensus-engine.js | 1,430 | 46 | PASS | mechanical |
| pipeline-studio.js | 1,419 | 17 | PASS | mechanical |
| cli-router.js | 1,402 | 60 | PASS | mechanical |
| bot-framework.js | 1,344 | 55 | PASS | mechanical |

**Total: 32,736 lines | 1,017 functions | 15/15 pass | 0 LLM tokens for extraction**

All files are real production JavaScript from a multi-agent fleet management system. Every edge case found during testing (default parameters with braces, nested arrow functions, IIFEs, template literal expressions, shebangs) was fixed and added to the permanent test corpus.
