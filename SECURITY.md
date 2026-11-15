# Security Policy

## Supported versions

Nexus is a pre-1.0 project. Security fixes are considered for the latest maintained release line only; no long-term support commitment is made for older versions.

## Reporting an issue

If the repository enables **GitHub Private Vulnerability Reporting**, use the **Security** tab to report a vulnerability privately. Otherwise, contact the maintainers through an established private channel. Please **do not** publish working exploit details or sensitive device information in a public GitHub issue before maintainers have an opportunity to assess the report.

Include the affected version, a minimal reproduction, the relevant environment (Node, Frida/Bridge, device where applicable), the impact, and any recommended mitigation. Reporting does not guarantee a particular response time or fix.

## Scope of automated validation

CI checks TypeScript, API/architecture boundaries, integration cases, and mocked Frida agent loading. It does **not** verify native ABI, Frida Gadget safety, ART behavior, or Unity IL2CPP behavior on physical devices. Bundled example offsets must not be treated as production-safe.
