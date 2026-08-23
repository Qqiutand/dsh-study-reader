# @deepseek-ai/dsh-study-reader

[English](README.md)

DeepSeek Harness 的文献库、无状态 PDF/EPUB 与 MinerU 预览，以及文献取证工具。

## 安装

在插件源码目录构建安装包：

```bash
pnpm install
pnpm run pack:dist
```

先显式选择安装目标，再到 DeepSeek Harness 仓库根目录执行。只有未设置
`DSH_HOME` 时，Harness 才默认使用 `$HOME/.dsh`：

```bash
export DSH_HOME="$HOME/.dsh"
pnpm dsh plugin --profile web add "/你的绝对路径/dist/deepseek-ai-dsh-study-reader-0.5.0.tgz"
pnpm dsh plugin --profile web exec dsh-study-reader-preset "$DSH_HOME" reading
```

第一条命令把插件安装到 `$DSH_HOME/profiles/web`，不会安装到源码目录；
第二条把插件自带的 `reading` Agent 预设安装到同一个 DSH home。完成后重新
启动 `pnpm dsh web`。

## 功能

- PDF/EPUB 文献库与文件夹
- 原版 PDF/EPUB 预览和有界 MinerU 结构化预览
- 本次对话范围内的文献权限
- 组合提示词注入、Skills 与 Tools 的配置预设
- MinerU 官方云端和兼容的本地 Docker 连接
- 通过 DSH Host locale 提供简体中文和英文界面

整个浏览器界面会跟随 DSH 的简体中文/英文偏好实时切换，无需重启。导入的标题和用户自己编写的内容保持原语言。

开发、安全与可复现源码打包说明见 [GitHub 仓库 README](https://github.com/Qqiutand/dsh-study-reader/blob/main/README.zh-CN.md)。

MIT
