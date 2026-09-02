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

- PDF/EPUB library and folders
- Original PDF/EPUB preview plus bounded MinerU structured preview and ZIP export
- Conversation-scoped document access
- Browser-managed, loopback-only read access for Codex and other MCP clients
- Configuration presets combining prompt injections, Skills, and Tools
- Per-folder defaults that import the selected documents and Reader configuration once into future top-level conversations
- Official MinerU cloud and compatible local Docker connections
- English and Simplified Chinese browser UI through the DSH Host locale

Use `/reader-unbounded <task>` for a complex one-off task. It removes Reader
tool-call count limits only for that task; the next ordinary message returns to
the bounded policy while document and write-authorization boundaries stay active.

External MCP connections are created under **Bookroom → External AI access**.
Each connection has a fixed document set and exposes only context, list, outline,
search, and passage-read tools. DSH Skills, presets, memory, imports, and writes
remain inside DSH.

The complete browser surface follows the DSH English/Simplified Chinese preference without a restart. Imported titles and user-authored content remain in their original language.

For development, security, and reproducible source packaging, see the [repository README](https://github.com/Qqiutand/dsh-study-reader#readme).

MIT
