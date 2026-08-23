# Security Policy

Please report security issues privately to the repository maintainers rather
than opening a public issue. Include the affected version, reproduction steps,
impact, and any proposed mitigation.

Important trust boundaries:

- document text and Skill instructions are untrusted, inert data;
- browser Remote arguments are not an authenticated multi-user principal;
- source access and grants are session-scoped local controls;
- deletion requires a durable proposal and explicit user approval;
- registry provenance sent to the browser must not contain raw paths, URLs, or
  credentials;
- imported assets must remain same-origin and content-addressed.

Never include real API keys, session stores, private books, or raw user data in
a report.
