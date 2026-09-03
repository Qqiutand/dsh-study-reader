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
- 可在浏览器中为 Codex、Antigravity 等客户端管理仅限本机的只读 MCP 授权
- 组合提示词注入、Skills 与 Tools 的配置预设
- MinerU 官方云端和兼容的本地 Docker 连接
- 通过 DSH Host locale 提供简体中文和英文界面

复杂任务可使用 `/reader-unbounded <任务>`。它只为该任务取消 Reader 工具调用
次数限制；下一条普通消息自动恢复，文献权限与写入授权等安全边界保持不变。

客户端授权在 **书房 → 外部 AI 访问** 中创建。每份授权由本机 MCP 地址和一枚
Bearer Token 组成，可包含多个命名书单。页面会同时生成 Codex 和 Antigravity
明文配置；有效授权可随时重新查看。两种客户端可以共用同一授权，Codex 配置无需
环境变量或 OAuth login。增删或修改书单不会更换 Token，也不需要修改客户端配置。
选择器支持分类以及独立的全部、已勾选、未勾选视图、本次对话文献和复制已有书单。MCP 提供
`reader_list_sets` 和五个只读文献工具；存在多个书单时，调用通过简短的 `setRef`
选择书单。`setRef` 不是密钥或环境变量。服务端不设置调用次数预算。DSH 的 Skills、
配置预设、记忆、导入和写入能力
仍留在 DSH 内部。

整个浏览器界面会跟随 DSH 的简体中文/英文偏好实时切换，无需重启。导入的标题和用户自己编写的内容保持原语言。

开发、安全与可复现源码打包说明见 [GitHub 仓库 README](https://github.com/Qqiutand/dsh-study-reader/blob/main/README.zh-CN.md)。

MIT
