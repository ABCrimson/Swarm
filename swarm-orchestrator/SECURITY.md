# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SWARM Orchestrator, please report it responsibly.

**Do NOT open a public issue.**

Instead, please use [GitHub Security Advisories](https://github.com/crimson-dev/swarm-orchestrator/security/advisories/new) or email security@crimson.dev. Include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Measures

- All IPC commands validate input at the boundary
- API keys are never logged or serialized
- Content Security Policy enforced via Tauri configuration
- Update signatures verified via public key
- File system access scoped to application data directory
- No `eval()` or `new Function()` usage
