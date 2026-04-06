# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-06

### Added
- One-command decompose: `refactory decompose myfile.js`
- Deep analysis: health scoring, business logic detection, risk assessment
- Dependency mapping with circular detection
- Characterization tests + golden export snapshots
- Mechanical import fixing (no LLM)
- Progress logging with timestamps and API cost tracking
- Mermaid diagrams in reports
- Tool-agnostic next-step prompts
- Full documentation: quickstart, pipeline ref, API key guide, case studies
- Landing page

## [0.1.0] - 2026-04-05

### Added
- MCP server with 6 tools (analyze, plan, extract, verify, metrics, report)
- Provider router: Groq -> Gemini -> OpenRouter -> SambaNova with auto-fallback
- Capability-named key slots
- CLI entry point
- Test fixtures and router tests

[0.2.0]: https://github.com/codedrop-codes/refactory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/codedrop-codes/refactory/releases/tag/v0.1.0
