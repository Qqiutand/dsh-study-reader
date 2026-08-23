# @deepseek-ai/dsh-study-reader

[简体中文](README.zh-CN.md)

Document library, stateless PDF/EPUB and MinerU preview, and evidence tools for DeepSeek Harness.

## Install

Build the bundle from the repository checkout:

```bash
pnpm install
pnpm run pack:dist
```

Choose the destination explicitly, then run from the DeepSeek Harness
repository root. Harness defaults to `$HOME/.dsh` only when `DSH_HOME` is not
set:

```bash
export DSH_HOME="$HOME/.dsh"
pnpm dsh plugin --profile web add "/absolute/path/to/dist/deepseek-ai-dsh-study-reader-0.5.0.tgz"
pnpm dsh plugin --profile web exec dsh-study-reader-preset "$DSH_HOME" reading
```

The first command installs the plugin under `$DSH_HOME/profiles/web`; it does
not install into the source checkout. The second installs the bundled
`reading` agent preset into the same DSH home. Restart `pnpm dsh web`
afterwards.

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
