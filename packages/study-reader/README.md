# dsh-study-reader

[简体中文](README.zh-CN.md)

Document library, stateless PDF/EPUB and MinerU preview, and evidence tools for DeepSeek Harness.

## Install

With the source checkout inside the DeepSeek Harness root, run:

```bash
pnpm run install:dsh -- --dsh-home "$HOME/.dsh"
```

This installs dependencies, builds and verifies the package, installs the
`web` profile bundle and its `reading` preset, and migrates the former package
name automatically. Restart `pnpm dsh web` afterwards.

## Features

- PDF/EPUB library and folders
- Original PDF/EPUB preview plus bounded MinerU structured preview and ZIP export
- Conversation-scoped document access
- Configuration presets combining prompt injections, Skills, and Tools
- Official MinerU cloud and compatible local Docker connections
- English and Simplified Chinese browser UI through the DSH Host locale

The complete browser surface follows the DSH English/Simplified Chinese preference without a restart. Imported titles and user-authored content remain in their original language.

For development, security, and reproducible source packaging, see the [repository README](https://github.com/Qqiutand/dsh-study-reader#readme).

MIT
