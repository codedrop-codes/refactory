# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it via
[GitHub Security Advisories](https://github.com/codedrop-codes/refactory/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

## Scope

Refactory handles LLM API keys and executes `node --check` on generated files.
We take both of these seriously:

- API key leakage through logs, error messages, or generated reports
- Code injection through malicious LLM output that bypasses validation
- Path traversal in file read/write operations

## Best Practices

- Never commit `.env` files or API keys to version control
- Use capability slots (`REFACTORY_KEY_*`) instead of sharing keys across tools
- Review extracted modules before running them in production

## Response Time

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 7 days
- **Fix or mitigation:** based on severity, typically within 30 days
