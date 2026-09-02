# DSH Study Reader

[English](README.md)

DSH Study Reader 是 DeepSeek Harness 的 PDF/EPUB 文献工作区，用于整理、解析和预览文献，并为对话提供范围明确的文献证据。

![Study Reader 空白书房](docs/bookroom-empty-zh.png)

_空白状态示意图，不包含真实文献或用户数据。_

## 功能

- 持久化文献库与文件夹管理，支持 PDF 和 EPUB。
- 预览原文件和 MinerU 结构化内容（不记录阅读位置），并将识别结果导出为 ZIP。
- 按当前对话授权文献，避免无关内容进入上下文。
- 可在浏览器中选择文献，为 Codex 等客户端创建仅限本机的只读 MCP 连接。
- 将提示词注入、Skills 和 Tools 保存为可复用的配置预设。
- 可按工作文件夹保存新会话默认的文献与 Reader 配置。
- 支持 MinerU 官方云端和兼容的本地 Docker 服务。
- 界面跟随 DSH 在简体中文与英文之间切换。

## 环境要求

- 最新的 DeepSeek Harness 源码工作区，以及该版本支持的 Node.js 和 pnpm。
- 云端解析 PDF 时需要 MinerU API Key；也可改用兼容的本地 Docker 服务。EPUB 始终在本地解析。

## 安装

把插件 clone 到 DeepSeek Harness 仓库根目录内，然后运行一键安装命令：

```bash
cd /你的绝对路径/deepseek-harness
git clone git@github.com:Qqiutand/dsh-study-reader.git
cd dsh-study-reader
pnpm run install:dsh -- --dsh-home "$HOME/.dsh"
```

它会安装依赖、构建并验证 `.tgz`、把插件安装到 `web` profile，再把自带的
`reading` Agent 预设安装到同一个 DSH home。完成后重新启动 `pnpm dsh web`。

如果插件不是 Harness 根目录的直接子目录，可显式指定 Harness 路径：

```bash
pnpm run install:dsh -- \
  --dsh-home "$HOME/.dsh" \
  --harness-root "/你的绝对路径/deepseek-harness"
```

## 配置

- 在 **书房 → 服务连接** 中配置 MinerU API Key 或本地 Docker 服务。
- 在 **书房 → 配置预设** 中组合提示词注入、Skills 和 Tools。
- 在书房中将需要的文献加入本次对话；预览文献不会自动授权。
- 在 **书房 → 总览** 中点击 **设为当前工作区默认**，可把当前勾选的文献和 Reader 配置保存给同一文件夹以后新建的顶级会话。每个新会话只导入一次，随后可以独立增删；已有会话和分叉会话不会被修改。
- 界面语言实时跟随 DSH；文献标题和用户内容保持原语言。

复杂任务可直接输入：

```text
/reader-unbounded <任务>
```

它只为这一次任务取消 Reader 工具的调用次数限制；下一条普通消息自动恢复。
文献权限、显式写入授权、单次超时和完全重复调用拦截不会被关闭。

### 外部 AI 访问（MCP）

打开 **书房 → 外部 AI 访问**，为书单填写显示名称和唯一的 Codex MCP 名称，
再从全部文献、未分类或任一文献文件夹中选择范围。也可以直接载入本次对话的文献，
或者复制已有连接的书单后生成新连接。

每个命名连接都有独立的 Bearer Token 和环境变量，因此可以让
`reader-probability` 访问一组书、`reader-optics` 访问另一组书。页面只显示一次
Token，并给出对应的 Codex 配置。保持
`pnpm dsh web` 运行，在启动 Codex 前导出页面给出的 Token，再把生成的配置写入
`~/.codex/config.toml`：

```toml
[mcp_servers.reader-probability]
url = "http://127.0.0.1:PORT/study-reader/mcp"
bearer_token_env_var = "DSH_STUDY_READER_PROBABILITY_TOKEN"
```

环境变量名由 MCP 名称稳定生成；多个连接的变量可以同时导出，不需要来回切换。
Token 值各不相同，才能保证每个书单可以单独授权和撤销。请复制页面实际生成的配置。

这个连接只提供 `reader_get_context`、`reader_list_documents`、
`reader_get_outline`、`reader_search_passages` 和 `reader_read_passage`。
外部 MCP 服务端不设置每轮或每个会话的 Reader 调用次数预算；单次结果大小、超时、
授权范围和不透明引用仍有边界，Codex 自身也可能受到会话时长、上下文或用量限制。
授权的文献集合保持不变；需要换书时，复制或新建连接并撤销旧连接即可。DSH 的配置预设、
Skills、会话记忆、导入、删除和笔记写入仍留在 DSH 内部，不会通过 MCP 暴露。

## 本地开发

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

也可以从 Harness 仓库根目录直接加载源码 patch，无需安装 `.tgz`：

```bash
pnpm dsh web --patch "/你的绝对路径/dsh-study-reader/cordis.patch.yml"
```

## 安全边界

- 导入的正文是不可信证据，不会被当作系统指令。
- 不可变安全基线始终生效，不能被配置预设关闭。
- MinerU 密钥由 Harness Credential Service 保存，不会返回浏览器。
- 文献访问权限按当前对话隔离。
- 外部 MCP 只接受本机连接。Token 仅在创建时显示，不写入授权记录；它会自动过期，也可以随时在浏览器中撤销。

## 许可证

MIT
