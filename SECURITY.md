# Security Policy

## Reporting a vulnerability

Please report privately via **[GitHub Security Advisories](https://github.com/ndunl075/sherlock/security/advisories/new)**
— not a public issue.

Expect an initial response within 72 hours. If a report is valid, you'll get
credit in the advisory unless you'd rather not.

## What counts as a vulnerability here

Sherlock's job gives it read access to entire source trees, so the interesting
bugs are about *containment*, not crashes. These are in scope and taken
seriously:

| Class | Example |
|---|---|
| **Code execution from a scanned repo** | any path where a file, config, or dependency in the *target* tree causes code to run |
| **Content leakage** | file contents, snippets, or secrets appearing in a report, `--json` output, cache, or error message |
| **Path escape** | reads outside the repo root via symlink, `../`, or junction |
| **Command injection** | attacker-controlled branch names or paths reaching a shell |
| **Unexpected network traffic** | any outbound request from any code path |
| **Cache poisoning** | a crafted repo causing Sherlock to write outside `.sherlock/` |

Out of scope: resource exhaustion from a genuinely enormous repo (bounded by
design, but a big repo is still slow), and findings that are simply wrong —
those are regular bugs, please file them publicly.

## Design commitments

These are invariants, not aspirations. A change that breaks one is a
vulnerability even if nothing is exploitable yet:

1. Nothing from a scanned repo is loaded, required, or executed.
2. No config inside a scanned repo grants privilege.
3. No file content is ever written to output or cache.
4. No network I/O in any code path.
5. Reads stay within the resolved repo root.

## Supported versions

Pre-1.0 (`0.x`). Once `1.0` ships, the latest minor gets security fixes.
