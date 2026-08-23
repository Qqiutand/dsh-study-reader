# dsh-study-reader

[English](README.md)

DeepSeek Harness 的文献库、无状态 PDF/EPUB 与 MinerU 预览，以及文献取证工具。

## 安装

插件源码放在 DeepSeek Harness 根目录内时，在源码目录运行：

```bash
pnpm run install:dsh -- --dsh-home "$HOME/.dsh"
```

该命令会完成依赖安装、构建、安装包验证、`web` profile 安装以及 `reading`
预设安装，并自动迁移旧包名。完成后重新启动 `pnpm dsh web`。

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
