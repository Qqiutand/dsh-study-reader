# dsh-study-reader

[English](README.md)

DeepSeek Harness 的文献库、无状态 PDF/EPUB 与 MinerU 预览，以及文献取证工具。

## 安装

插件源码放在 DeepSeek Harness 根目录内时，在源码目录运行：

```bash
pnpm run install:dsh -- --dsh-home "$HOME/.dsh"
```

该命令会完成依赖安装、构建、安装包验证、`web` profile 安装以及 `reading`
预设安装。完成后重新启动 `pnpm dsh web`。

## 功能

- PDF/EPUB 文献库与文件夹
- 原版 PDF/EPUB 预览和有界 MinerU 结构化预览
- 本次对话范围内的文献权限
- 可在浏览器中按文献创建仅限本机的只读 MCP 连接
- 组合提示词注入、Skills 与 Tools 的配置预设
- MinerU 官方云端和兼容的本地 Docker 连接
- 通过 DSH Host locale 提供简体中文和英文界面

复杂任务可使用 `/reader-unbounded <任务>`。它只为该任务取消 Reader 工具调用
次数限制；下一条普通消息自动恢复，文献权限与写入授权等安全边界保持不变。

外部 MCP 连接在 **书房 → 外部 AI 访问** 中创建。每个命名书单固定一组文献并生成
独立的 Codex MCP 名称和 Token 环境变量；选择器支持全部文献、未分类、文献文件夹、
本次对话文献以及复制已有书单。它只提供上下文、文献列表、目录、检索和正文读取
五个工具，服务端不设置调用次数预算。DSH 的 Skills、配置预设、
记忆、导入和写入能力仍留在 DSH 内部。

整个浏览器界面会跟随 DSH 的简体中文/英文偏好实时切换，无需重启。导入的标题和用户自己编写的内容保持原语言。

开发、安全与可复现源码打包说明见 [GitHub 仓库 README](https://github.com/Qqiutand/dsh-study-reader/blob/main/README.zh-CN.md)。

MIT
