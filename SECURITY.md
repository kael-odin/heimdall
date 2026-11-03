# Security Policy

## Supported versions

Heimdall is currently on the `2.0.0-dev` development line. Security fixes are
applied to `main`; older snapshots are not maintained as separate releases.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or a private Security
Advisory for this repository. Do not publish credentials, authenticated URLs,
raw HAR files, local session state, or exploitable proof-of-concept details in
a public issue.

Include:

- affected commit or version;
- whether the engine was bound to loopback or a shared interface;
- whether `HEIMDALL_TOKEN` was enabled;
- minimal reproduction steps with secrets removed;
- expected and observed behavior.

The project aims to acknowledge a complete report within seven days. This is a
small development project, so it does not promise a fixed remediation SLA.

## Security boundaries

- Heimdall is for public pages or pages the operator is authorized to access.
- It does not bypass authentication, CAPTCHA, or 2FA.
- The engine should stay bound to `127.0.0.1` unless token authentication and
  trusted-host configuration are deliberately set.
- Mirrors and captured evidence may contain copyrighted or sensitive material;
  they are not intended for public deployment by default.
