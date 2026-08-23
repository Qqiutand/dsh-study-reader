# Contributing

Thank you for improving DSH Study Reader.

1. Keep changes scoped to the plugin; do not modify a parent Harness checkout.
2. Preserve Source / Revision / Block identity and session isolation.
3. Treat Skill instructions and extracted document text as untrusted data.
4. Add focused regression coverage for behavior changes.
5. Before proposing a change, run typecheck, focused tests, build, and
   `git diff --check`. Run isolated installed-package E2E for packaging or
   browser-lifecycle changes.

Do not commit credentials, user books, local `.dsh` profiles, generated
bundles, browser traces, or temporary extraction artifacts.
