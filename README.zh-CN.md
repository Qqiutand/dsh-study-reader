# DSH Study Reader

[English](README.md)

DSH Study Reader 是 DeepSeek Harness 的文献工作区，提供带文件夹的 PDF/EPUB 文献库、本地或 MinerU 解析、原文件与结构化预览，以及面向文献问答的精简取证工具。

![Study Reader 空白书房](docs/bookroom-empty-zh.png)

_界面示意图为空白状态，不包含任何真实文献、文件夹名称或用户数据。_

## 主要功能

- 把 PDF 和 EPUB 导入持久化文献库并按文件夹整理。
- 预览原版 PDF/EPUB 和 MinerU 结构化内容，不保存阅读页码或滚动位置。
- 将 MinerU 识别结果导出为 ZIP，包含 Markdown、JSONL 文本块、目录元数据和引用图片。
- 明确控制本次对话可以使用哪些文献。
- 将提示词注入、专项 Skills 和 Tools 组合为可复用的配置预设。
- 连接 MinerU 官方云端，或兼容的本地 Docker 服务。
- 跟随 DSH Host 语言设置，浏览器界面支持简体中文和英文。

## 环境要求

- 最新的 DeepSeek Harness 源码工作区。
- Harness 当前支持的 Node.js 与 pnpm 版本。
- 云端 PDF 解析需要 MinerU API Key；也可以使用兼容的本地 Docker 服务。EPUB 在本地解析。

## 从源码构建并安装

请把插件 clone 到 **DeepSeek Harness 仓库根目录内**。源码构建会链接当前
Harness 工作区中的平台包：

```bash
cd /你的绝对路径/deepseek-harness
git clone git@github.com:Qqiutand/dsh-study-reader.git
cd dsh-study-reader
pnpm install
pnpm run pack:dist
```

`pack:dist` 会构建 Host 与浏览器代码，在 `dist/` 生成一个可安装的 `.tgz`，并验证安装包可以独立运行。

先选择插件要安装到哪个 DSH 数据目录。`DSH_HOME` 是安装根目录；如果没有
设置，Harness 才会默认使用 `$HOME/.dsh`。下面把默认目标显式写出来：

```bash
export DSH_HOME="$HOME/.dsh"
```

你可以把它换成其他绝对路径，例如 `/srv/dsh-demo`。插件会安装到
`$DSH_HOME/profiles/web`；前面 clone 的源码目录只负责构建，不是安装目录。

然后回到 **DeepSeek Harness 仓库根目录**执行：

```bash
cd ..
pnpm dsh plugin --profile web add "$PWD/dsh-study-reader/dist/deepseek-ai-dsh-study-reader-0.5.0.tgz"
pnpm dsh plugin --profile web exec dsh-study-reader-preset "$DSH_HOME" reading
```

这是两个不同层次：

1. `plugin ... add` 因为使用了 `--profile web`，会把 Study Reader bundle
   安装到 `$DSH_HOME/profiles/web`。
2. `dsh-study-reader-preset` 把插件自带的 `reading` Agent 预设安装到同一个、
   已显式选择的 DSH home。

安装或更新后，重新启动 `pnpm dsh web`。

## 开发与验证

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:dist
pnpm run verify:dist
```

本地开发时也可以不安装 `.tgz`，而是在 Harness 根目录直接加载 patch：

```bash
pnpm dsh web --patch "/你的绝对路径/dsh-study-reader/cordis.patch.yml"
```

## 语言

Study Reader 跟随 DSH 的语言偏好。在 DSH 中切换简体中文或英文后，无需重启即可更新整个插件界面，包括书房、文献库与导入弹窗、配置预设、提示词注入、Skills、Tools、访问权限、MinerU 连接、状态和可恢复错误页。文献标题和用户自己编写的内容保持原语言。

## 配置

在 **书房 → 服务连接** 中配置 MinerU。官方云端连接默认存在；你也可以添加兼容的本地 Docker 地址，并选择协议模式、后端、超时、OCR、表格、公式和默认识别语言。

在 **书房 → 配置预设** 中组合提示词注入、Skills 和 Tools。不可变安全基线始终生效；用户创建的预设可以编辑、用于本次对话或永久删除。

## 安全边界

- 导入的正文属于不可信证据数据，不能作为系统指令。
- 密钥由 Harness Credential Service 保存，不会返回浏览器。
- 文献访问权限按当前对话隔离。
- 管理写入使用显式命令、版本检查和持久化回执。

## 打包

- 安装包：`pnpm run pack:dist`
- 验证安装包：`pnpm run verify:dist`
- 可复现源码包：`pnpm run pack:source`
- 验证源码包：`pnpm run verify:source`

## 许可证

MIT
