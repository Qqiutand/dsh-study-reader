# dsh-study-reader

[简体中文](README.zh-CN.md)

Document library, stateless PDF/EPUB and MinerU preview, and evidence tools for DeepSeek Harness.

## Install

With the source checkout inside the DeepSeek Harness root, run:

```bash
pnpm run install:dsh -- --dsh-home "$HOME/.dsh"
```

This installs dependencies, builds and verifies the package, installs the
`web` profile bundle and its `reading` preset. Restart `pnpm dsh web` afterwards.

## Features

- PDF/EPUB library, folders, and multi-file import into one destination folder
- Original PDF/EPUB preview plus bounded MinerU structured preview and ZIP export
- Conversation-scoped document access
- Browser-managed, loopback-only read access for Codex, Antigravity, and other MCP clients
- Configuration presets combining prompt injections, Skills, and Tools
- Per-folder defaults that import the selected documents and Reader configuration once into future top-level conversations
- Official MinerU cloud and compatible local Docker connections
- English and Simplified Chinese browser UI through the DSH Host locale

Use `/reader-unbounded <task>` for a complex one-off task. It removes Reader
tool-call count limits only for that task; the next ordinary message returns to
the bounded policy while document and write-authorization boundaries stay active.

Client authorizations are created under **Bookroom → External AI access**. Each
authorization is one loopback MCP URL plus one bearer token and may contain several
named reading sets. The page generates both Codex and Antigravity configurations;
both are shown in plaintext and may be reopened for any active authorization.
The clients may share one authorization, and the Codex configuration requires
neither an environment variable nor OAuth login. Editing sets does not rotate
the token or change either client configuration. The picker combines folder
categories with independent all, selected, and unselected views, current-conversation
documents, and copying an existing set. MCP exposes `reader_list_sets` plus the
five read-only evidence tools; calls use a short `setRef` runtime selector when the
authorization has multiple sets. It applies no server-side call-count budget. DSH Skills, presets,
memory, imports, and writes remain inside DSH.

The complete browser surface follows the DSH English/Simplified Chinese preference without a restart. Imported titles and user-authored content remain in their original language.

For development, security, and reproducible source packaging, see the [repository README](https://github.com/Qqiutand/dsh-study-reader#readme).

MIT
