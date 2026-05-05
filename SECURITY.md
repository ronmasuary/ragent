# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: ronmas2@gmail.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You'll receive a response within 48 hours. Please allow time to patch before public disclosure.

## Known limitations

- `shell_exec` runs commands without sandboxing — enable `API_KEY` auth before exposing port 3456 publicly
- HTTP server has no rate limiting — recommended to keep behind a firewall or VPN
- Skills run arbitrary code — only install skills from trusted sources
