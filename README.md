# DSH Study Reader

[简体中文](README.zh-CN.md)

DSH Study Reader is a document workspace for DeepSeek Harness. It combines a foldered PDF/EPUB library, local or MinerU extraction, original-document and structured previews, and a small evidence-tool surface for document-grounded conversations.

![Empty Study Reader Bookroom](docs/bookroom-empty-en.png)

_Illustrative empty state. It contains no imported documents, folder names, or user data._

## Highlights

- Import PDF and EPUB documents into a durable, foldered library.
- Preview original PDF/EPUB content and MinerU structured output without persisting a reading position.
- Export MinerU results as a ZIP containing Markdown, JSONL blocks, outline metadata, and referenced images.
- Decide exactly which documents the current conversation may use.
- Configure prompt injections, specialized Skills, and Tools as reusable configuration presets.
- Connect to the official MinerU cloud service or a compatible local Docker endpoint.
- Follow the DSH Host locale: the browser interface supports English and Simplified Chinese.

## Requirements

- A current DeepSeek Harness source checkout.
- Node.js and pnpm versions supported by that checkout.
- A MinerU API key for cloud PDF extraction, or a compatible local Docker service. EPUB extraction is local.

## Build and install from source

Clone the plugin **inside the DeepSeek Harness repository root**. The source
workspace intentionally links to Harness packages during compilation:

```bash
cd /absolute/path/to/deepseek-harness
git clone git@github.com:Qqiutand/dsh-study-reader.git
cd dsh-study-reader
pnpm install
pnpm run pack:dist
```

`pack:dist` builds the Host and browser bundles, creates one installable `.tgz` under `dist/`, and verifies that the package is self-contained.

Choose the DSH data directory that should receive the plugin. `DSH_HOME` is
the installation root; if it is not set, Harness uses `$HOME/.dsh`. The
following example makes the target explicit:

```bash
export DSH_HOME="$HOME/.dsh"
```

You may replace that value with another absolute directory, for example
`/srv/dsh-demo`. The plugin will be installed under
`$DSH_HOME/profiles/web`; the cloned source directory remains only a build
checkout.

Then return to the **DeepSeek Harness repository root**:

```bash
cd ..
pnpm dsh plugin --profile web add "$PWD/dsh-study-reader/dist/deepseek-ai-dsh-study-reader-0.5.0.tgz"
pnpm dsh plugin --profile web exec dsh-study-reader-preset "$DSH_HOME" reading
```

The two commands install different layers:

1. `plugin ... add` installs the Study Reader bundle into
   `$DSH_HOME/profiles/web` because `--profile web` is selected.
2. `dsh-study-reader-preset` installs the bundled `reading` agent preset into
   the same explicitly selected DSH home.

Restart `pnpm dsh web` after installing or updating the plugin.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:dist
pnpm run verify:dist
```

For local development without installing a tarball, use the repository patch from the Harness root:

```bash
pnpm dsh web --patch "/absolute/path/to/dsh-study-reader/cordis.patch.yml"
```

## Language

Study Reader follows the DSH language preference. Switching DSH between English and Simplified Chinese updates the complete plugin surface without a restart: Bookroom, library and import dialogs, configuration presets, prompt injections, Skills, Tools, access controls, MinerU connections, status copy, and recoverable error views. Imported titles and user-authored content remain in their original language.

## Configuration

Open **Bookroom → Service connections** to configure MinerU. The official cloud endpoint is present by default. Additional connections may target a compatible local Docker endpoint and choose its API mode, backend, timeout, OCR, table, formula, and default-language settings.

Open **Bookroom → Configuration presets** to combine prompt injections, Skills, and Tools. The immutable safety baseline always applies; user-created presets can be edited, applied to the current conversation, or deleted.

## Security model

- Imported document text is untrusted evidence data, never instructions.
- Secrets are stored through the Harness Credential Service and are not returned to the browser.
- Document access is scoped to the current conversation.
- Management writes use explicit commands, versions, and durable receipts.

## Packaging

- Installable bundle: `pnpm run pack:dist`
- Bundle verification: `pnpm run verify:dist`
- Reproducible source archive: `pnpm run pack:source`
- Source archive verification: `pnpm run verify:source`

## License

MIT
