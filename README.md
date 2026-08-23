# DSH Study Reader

[简体中文](README.zh-CN.md)

DSH Study Reader is a PDF/EPUB workspace for DeepSeek Harness. It organizes, extracts, and previews documents while providing clearly scoped evidence for document-grounded conversations.

![Empty Study Reader Bookroom](docs/bookroom-empty-en.png)

_Illustrative empty state with no real documents or user data._

## Features

- Persistent PDF/EPUB library with folders.
- Original-document and MinerU structured previews without saved reading positions, with ZIP export of extraction results.
- Conversation-scoped document access that keeps unrelated content out of context.
- Reusable presets combining prompt injections, Skills, and Tools.
- Official MinerU cloud and compatible local Docker services.
- English and Simplified Chinese UI that follows the DSH locale.

## Requirements

- A current DeepSeek Harness source checkout and the Node.js and pnpm versions it supports.
- A MinerU API key for cloud PDF extraction, or a compatible local Docker service. EPUB extraction is always local.

## Installation

Clone the plugin inside the DeepSeek Harness repository root so the build can link to Harness platform packages:

```bash
cd /absolute/path/to/deepseek-harness
git clone git@github.com:Qqiutand/dsh-study-reader.git
cd dsh-study-reader
pnpm install
pnpm run pack:dist
```

`pack:dist` creates and verifies an installable `.tgz` under `dist/`. Then choose the DSH data directory and install from the Harness repository root:

```bash
export DSH_HOME="$HOME/.dsh"
cd ..
pnpm dsh plugin --profile web add "$PWD/dsh-study-reader/dist/deepseek-ai-dsh-study-reader-0.5.0.tgz"
pnpm dsh plugin --profile web exec dsh-study-reader-preset "$DSH_HOME" reading
```

The plugin is installed under `$DSH_HOME/profiles/web`, and the `reading` agent preset is installed into the same DSH home. Restart `pnpm dsh web` after installing or updating.

## Configuration

- Open **Bookroom → Service connections** to configure a MinerU API key or local Docker service.
- Open **Bookroom → Configuration presets** to combine prompt injections, Skills, and Tools.
- Add only the documents you need to the current conversation; previewing a document does not grant access.
- The UI follows the DSH locale immediately; document titles and user-authored content keep their original language.

## Local development

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

You can also load the source patch directly from the Harness repository root without installing a `.tgz`:

```bash
pnpm dsh web --patch "/absolute/path/to/dsh-study-reader/cordis.patch.yml"
```

## Security boundaries

- Imported text is untrusted evidence and is never treated as system instructions.
- The immutable safety baseline remains active and cannot be disabled by presets.
- Secrets are stored by the Harness Credential Service and are not returned to the browser.
- Document access is isolated to the current conversation.

## License

MIT
