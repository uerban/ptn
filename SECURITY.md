# Security policy

## Supported versions

PTN is pre-1.0. Security fixes are made on `main` and included in the next
published image, binary, or release. Older commits, images, and forks are not
maintained by this project.

## Report a vulnerability privately

Do not open a public issue with vulnerability details. Use GitHub's
[private vulnerability reporting form](https://github.com/uerban/ptn/security/advisories/new).

Include the affected commit or version, deployment mode, impact, reproduction
steps, and any suggested mitigation. For privacy regressions, describe the
network or storage behavior without including a real person's location, trip,
credentials, or feed token.

If the private-reporting button is unavailable, open a public issue containing
only a request for a private security contact. Do not include the vulnerability
or proof of concept in that issue.

Reports are handled through coordinated disclosure. Please allow maintainers a
reasonable opportunity to investigate and release a fix before public
disclosure.

## In scope

Security reports include conventional software vulnerabilities and failures of
PTN's privacy boundaries, such as:

- precise location or trip data leaving the device contrary to the active
  policy;
- an opt-in or coarsening control being bypassed;
- unauthorized access to locally stored rider data;
- unsafe parsing of GTFS, PTB, PTFT, or real-time feed data; and
- CI, build, update, or release paths that could execute untrusted code with
  credentials or persistent infrastructure access.

Operational outages, stale feeds, and ordinary routing errors belong in the
public bug tracker unless they expose sensitive data or cross a security
boundary.
