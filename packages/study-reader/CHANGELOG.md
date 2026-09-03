# Changelog

## 0.8.1 - 2026-09-03

- Added an explicit selected-document view to the external MCP reading-set picker, with a live count and bilingual empty state.
- Aligned selected rows and checkboxes with the Study Reader theme so the current reading-set scope remains visible while browsing folders or search results.
- Explained each reading set identifier in context, added one-click copy, and removed horizontal overflow from the connection list on narrow layouts.
- Removed revoked connections from the management list immediately while retaining their server-side audit records.

## 0.8.0 - 2026-09-03

- Replaced the connection-per-document-set workflow with stable client connections containing up to 32 named reading sets. Adding, editing, or deleting a set no longer rotates the bearer token or changes the Codex MCP configuration.
- Added the read-only `reader_list_sets` MCP tool and a short `setRef` selector on the five evidence tools. The selector may be omitted while a connection contains exactly one set; once it contains several, calls must name the set explicitly.
- Kept existing v0.7.x connections and tokens valid by projecting their fixed scope as `set_default`. Added browser controls for set reuse, folder-based selection, in-place editing, copying, and deletion while preserving cross-set authorization boundaries.

## 0.7.1 - 2026-09-02

- Turned external connections into named reading sets: every grant now generates its own Codex `mcp_servers` key and token environment variable, so multiple fixed document sets can be configured at the same time. Existing v0.7.0 connections remain compatible as `dsh_reader`.
- Added library-folder filtering with all-document and uncategorized views, an explicit “use current conversation” action, and a safe “copy set” action for creating a new connection from an existing document scope.
- Clarified that embedded external MCP reads have no per-turn or per-session call-count budget, and added repeated-call regression coverage. Per-call result, timeout, authorization, and opaque-reference boundaries remain enforced.

## 0.7.0 - 2026-09-02

- Added a loopback-only Streamable HTTP MCP endpoint over the existing Study Reader library. External clients receive only the five read-only Reader tools and never gain import, deletion, note-write, Skill, preset, or conversation-memory access.
- Added a small browser control plane for selecting a fixed document set, creating an expiring bearer connection, copying Codex configuration, and revoking the connection immediately. Raw tokens are shown only by the create response and are not stored in authorization records.
- Reused the existing opaque document/passage references and Reader dispatch path, with per-request authorization checks, bounded request/response sizes, DNS-rebinding validation, and regression coverage for the complete HTTP tool flow.

## 0.6.2 - 2026-09-02

- Rebalanced the Bookroom library column for normal-height browser windows: the search controls, import notice, and conversation shelf are more compact, while the full document-card list receives the remaining height and keeps its own scroll.

## 0.6.1 - 2026-09-02

- Made document titles in the compact conversation shelf open the existing Bookroom preview without changing conversation access; the adjacent Remove action remains independent.

## 0.6.0 - 2026-09-02

- Added a per-folder Workspace default on the Bookroom Overview. It snapshots the current conversation's document grants and pinned Reader configuration for future top-level conversations in the same DSH working directory.
- Workspace defaults are imported once before a new conversation's first Reader turn. Existing conversations, forks, and subagents are unchanged, and later per-conversation edits are never reapplied or written back to the template.
- Added durable application receipts, restart coverage, CAS-guarded updates, source-deletion cleanup, and protection for Profile revisions referenced by an active Workspace default.

## 0.5.9 - 2026-09-02

- Fixed `/reader-unbounded` command turns being cached as bounded when DSH queried pre-step Skill eligibility before committing the queued user message.
- Clarified bounded shared-budget errors so the model cannot infer that passage reads are unlimited after discovery calls exhaust the shared allowance.

## 0.5.8 - 2026-09-02

- Added `/reader-unbounded <task>` for a single complex Reader task without per-turn tool-call or attempt-count limits; the next ordinary message automatically returns to the configured bounded policy.
- The command adds short turn-local runtime guidance so the model knows the count limit is lifted while document grants, explicit write authorization, per-call timeouts, and exact duplicate-call protection remain active.

## 0.5.7 - 2026-08-31

- Migrated the removed Client Runtime/API wrapper, Session projection, Tool-call ID, and shared JSON contracts to their DSH 0.1.2-alpha.2 owners.
- Made the one-command installer content-address its cached tarball so rebuilding the same version cannot leave an older bundle installed.

## 0.5.6 - 2026-08-24

- The shared discovery budget now reserves two final `reader_read_passage` calls and one explicitly authorized `reader_save_note` call, so directory and search work cannot prevent the assistant from reading or saving the evidence it already found.
- Search guidance now tells the model to use or read a useful hit before issuing another search; duplicate and stopped-search errors are reported before the broader budget limit, and the malformed-call attempt allowance is raised from 8 to 15.
- Removed unused per-Skill budget metadata so the centralized runtime guard is the only declared call-budget policy.

## 0.5.5 - 2026-08-24

- Removed the unimplemented `reader_open_location` Tool and its navigation capability, authorization path, catalog entry, and preset promises. The authoritative catalog now contains five read-only evidence Tools plus the explicitly authorized `reader_save_note` Tool.

## 0.5.4 - 2026-08-24

- Audited all seven Reader Tools and added model-visible selector examples, allowed target kinds, numeric/cardinality limits, and exact save-note requirements where Harness's compact Tool Schema cannot encode those bounds directly.
- `reader_save_note` now reports a path-specific validation error for an invalid evidence-reference list instead of a generic parse failure.

## 0.5.3 - 2026-08-24

- `reader_search_passages.scope` now accepts a direct `document_ref` or `document_title` for a single-document search, while preserving the existing multi-document and conversation-wide forms.
- Native DSH Tool registration now preserves parameter descriptions, examples, defaults, and titles, and the search/read descriptions show exact argument shapes while making clear that JSON key order is irrelevant.

## 0.5.2 - 2026-08-24

- Corrected the `reading` preset description to advertise only currently reachable Reader Tools and bundled Skills.

## 0.5.1 - 2026-08-24

- Published the community distribution as `dsh-study-reader`.
- Added `pnpm run install:dsh` to build, verify, and install both the web-profile bundle and bundled `reading` preset in one explicit command; installed tarballs live under `DSH_HOME` so source rebuilds cannot break profile dependencies.
- Copied or custom DSH agent presets that still compose `dsh-study-reader/tools` now activate the Bookroom by capability instead of requiring the fixed `reading` id; the preset chooser description is also shorter.

## 0.5.0 - 2026-08-22

- MinerU PDF revisions can be exported as a normalized ZIP containing Markdown, JSONL blocks, outline metadata, and referenced images.
- Agent 文献路径改为完整的本次对话文献目录注入 → 五个默认可见的只读取证 Tool → Principal 绑定调度 → 结构化结果；目录不含正文、阅读位置、界面预览选择或 Host ID，插件不再注册旧 `study_*` 取证工具或复制 Harness 轨迹。
- 默认 Reader 能力固定为七个严格工具：对话文献状态、列出文献、目录、段落检索、段落阅读、导航和保存笔记。Host ID 只存在于每轮私有资源映射，模型只得到临时引用与人类可读位置；导航和持久写入仅在用户明确表达对应意图时暴露，重复调用和空检索改写仍由 Host 前置门禁。
- Reading Preset 删除定位、解释、总结和比较四个普通任务 Skill，只保留七个特殊方法 Skill。Skill 只指导证明重建、论证追踪、跨文献综合、练习、理解评估、学习规划或显式保存的方法，不解锁 Reader Tool，也不改变统一的调用预算。
- 七个系统阅读 Skill 由当前插件包的只读 Harness provider 注册；Reading Preset 不再把 Skill 复制到 `~/.dsh`。插件重载会注销并重新注册 provider、触发 Registry 失效，用户克隆的 managed Skill 不受升级影响；旧复制式 Preset 可通过一次 `--migrate` 原子替换并保留备份。
- 工作区用语与信息架构统一面向用户：新增“总览”，将 Prompt/Profile 分别呈现为“提示词注入 / 配置预设”，Skill 统一使用同一名称，并统一文献的“加入本次对话 / 移出本次对话”状态表达。
- 总览支持把当前提示词注入、Skills 与 Tools 另存为新配置预设；不会误存文献、阅读位置或服务连接，也不会自动切换当前对话。
- 文献卡片支持下载原文件和经书名确认的永久删除；删除后会读取 Host 权威选择版本，继续打开其他文献不会发生版本冲突。
- 用户创建的 Skill 支持“归档 → 永久删除”：系统 Skill 不可删除，未归档或仍被任一工作方案修订引用时 Host 会拒绝，并以持久化删除凭据保证重放幂等。
- Studio 左侧导航支持收起为图标栏；书房改为紧凑工具栏，文献列表会在打开文献后收起，目录默认隐藏且可随时展开，从而把主要空间留给正文预览。
- Study Studio 采用统一的类型化资产导航：文献、Prompt、Skill、Profile 文件夹通过 Host `listTreeChildren` 按展开加载，资产列表通过 `listAssets` 分页，详情由 `getAssetDetail` 显式读取；循环、跨 namespace 移动、非空删除、CAS 和 commandId 重放仍由 Host 强制。
- 统一资产树现直接承担四类文件夹的新建、重命名、移动和空目录删除；列表卡片通过键盘可达的“移动到…”对话框或右键快捷入口移动，不再各自维护第二套文件夹导航。文献列表与 Host 搜索支持翻页超过 100 项，Studio Snapshot 不再下发全部 Prompt/Profile 修订正文。
- 提示词注入和配置预设改为普通的“保存修改”交互，不再向用户暴露修订号、历史版本或版本切换；保存正在使用的配置预设会立即应用到本次对话。内部记录号只用于防止并发覆盖。
- 提示词注入、配置预设和用户 Skill 默认只显示可用内容，归档内容放入独立视图；归档后且未被引用/使用时可永久删除。
- 配置预设仍支持 Prompt 顺序和 Tool guidance；编译器固定安全基线并生成可审计清单，但界面不再把内部修订实现呈现为产品功能。编译 Manifest 不携带单一当前文献；Skill 目录与正文完全交给 Harness 原生 Skill Registry。
- Skill 修订增加独立调用条件与 Tool 依赖；当前 Profile 固定的 Skill 修订通过 Harness Skill Registry 按需加载，默认不把全文塞进每轮 Prompt。
- MinerU 服务页可持久化并即时应用 endpoint、模型、超时、语言及 OCR/表格/公式开关，并由 Host 执行健康测试。秘密仍只存在于 Harness Credential Service；默认部署配置只有用户显式保存后才成为 durable override。
- 插件自定义轨迹、Conversation Snapshot 订阅和重复 Tool 事件已物理删除；Tool/Turn 轨迹完全交给 Harness 官方界面。
- 浏览器界面接入 DSH Host locale，书房、资产管理、配置预设、提示词注入、Skills、Tools、权限、MinerU 连接、弹窗和错误界面可在简体中文/英文间实时切换。

## 0.4.0 - 2026-08-22

- Restored usable stateless document previews: one-click grant-and-open, a consistent library snapshot, native PDF framing with fallback links, semantic EPUB blocks and revision images, active-only import status, and a responsive library/preview/evidence layout. Reading position, CFI, zoom, and scroll state remain deliberately unpersisted.

- 新增统一 Study Studio：树状管理文献、Prompt、Profile、Skill、Tool、权限与 Provider；Prompt/Profile 使用追加修订、CAS 和幂等命令，Profile 固定版本后在 Harness 系统提示词装配边界真实生效。
- 六个运行时 Tool 及其 Studio Inspector 由同一份 `STUDY_TOOL_SPECS` 生成；Profile 编译器输出稳定 Prompt/Tool Set hash、依赖诊断和 Manifest。
- MinerU 凭据入口移入 Studio，但 Secret 仍只通过 Harness Credential Service 写入；Studio 仅显示非秘密连接参数和健康状态。

- 以轻量文献库、浏览器原生 PDF 预览和有界 EPUB/文本预览替代完整状态化阅读器。
- 物理删除 ReaderPosition、ReaderState、BookState、ContextPack 与恢复协调链；PDF.js/EPUB.js 仅作为无持久化阅读组件保留。
- 默认 Agent 能力缩减为六个只读取证工具；Host 在 search/read/outline/term-profile 内解析当前明确选择的文献。
- 新增独立、纯读取的 SessionSourceSelection；授权撤销、选择和来源删除共享一致性协调边界。
- 导入生命周期不再进入 Agent inbox；物理删除插件自定义轨迹、Agent Conversation 订阅、`listStudyEvents` 浏览器 Remote 与重复的取证 Tool 事件，Turn/Tool 日志统一交给 Harness 官方轨迹。
- 默认 Skills 只引用六个已注册工具，Skill 与发行包文本均通过 fatal UTF-8 校验。
- 删除旧 Quick Actions、认知 Dock 和未挂载阅读组件。

## Historical pre-release notes (superseded by 0.4.0)

- 新增按需加载的分层学习 Skills：用户态/书本态校准、个性化引导阅读、逐步证明重建、书内深度检索与显式“摸底—路线—教学—反馈”闭环；普通问答不再自动进入测验流程。
- Reading Preset 增加紧凑的全局证据门：模型自创类比必须标成辅助内容，不能冒充书中章节或作者术语；“全书没有”“作者偏爱/总是使用”等全局判断必须有完整目录、多变体检索与跨章节证据，局部用词不足时明确降级表述。
- 新增只读 `study_term_profile`，对不可变 Revision 的全部 canonical blocks 执行有界参数、全量 NFKC/lowercase 字面扫描；ContextPack 同时返回稳定版本清单，`study_read`/`study_search`/Pack/词项样本返回 importer 证明的 EPUB XHTML 原生定位。
- 统一修订费曼、苏格拉底、图尔敏、论文、社科与理论图谱 Skills：BlockId 不再单独充当引用，作者明示、AI 综合和外部知识分开；移除根据一次回答诊断“达克效应”的规则。
- Bookroom 增加两级书库与独立 Skill 文件夹、Session 级 Agent 权限、固定 Skill Revision、危险删除提案及持久化命令恢复；Agent 不能自授权限或直接删除来源。
- PDF.js 随发布包提供受白名单约束的 JBig2/OpenJPEG/QCMS WASM，并通过同源插件资源路由加载；扫描型 PDF 不再因缺少 `wasmUrl` 而只显示空白 Canvas。
- 书房与轨迹改由插件自有 Study Root 呈现；不再注册 `conversation.view` 宿主呈现元数据，也不依赖或修改宿主 Composer/DOM。切换“对话”只隐藏插件 Workspace，Harness 原始 Composer 保持可用。
- 修正连续 EPUB 全书检索：远端检索失败与检索命中后的本地定位分离处理，定位回调不能再被误报成“检索失败”；点击级回归补齐原生 Reader Registry 依赖并断言成功检索不显示错误。
- PDF.js 的 TextLayer 恢复现与 EPUB CFI 共享同一 Restore Coordinator：恢复中的 viewport 观测不会反向写入 Reader State，且迟到的旧 PDF render 只有携带当前 Locator 回执时才能完成恢复。
- 新增独立的 `ctx.studyReaderState` Broker 与 Durable Provider。阅读位置以 `sessionId + sourceId + revisionId` 保存，不再与 Bookroom Shell Snapshot 混存，也不会被其他书籍或延迟工作区快照覆盖。
- 位置协议采用可区分的 `epub-cfi`、`pdf-text`、`pdf-ocr` 与明确标记为 `approximate` 的 `legacy-block` Locator；旧 Block/滚动记录不再伪装成精确文字锚点。
- PDF 原版视图改用 PDF.js Canvas + TextLayer；读者看到原 PDF，TextLayer 仅用于选择文字。选区保存原页、TextLayer 字符范围、精确文本与矩形，并只在后台将选择匹配至 MinerU Block 供 Agent 取证。
- EPUB 原版视图改用 epub.js 连续流并保存 CFI；恢复时抑制初次 `relocated` 写回，后续用户滚动才更新位置和目录章节指示。
- EPUB 位置现以点 CFI 加原版文本见证保存；恢复同时校验 CFI 与文本。划选产生的 CFI Range 不再覆盖阅读位置，首次没有旧记录或 Host 暂不可读时会转入可写状态并保留本地 Outbox。
- `study-reader-state` 与 Durable Provider 现已写入 Bundle Patch 并随安装启用；Reader Position Outbox 使用 IndexedDB 保存每个 `sessionId + sourceId + revisionId` 的最新未确认位置，`localStorage` 仅作页面关闭时同步镜像。旧版单条记录可自动读取并迁入新版分区，陈旧 `clientSequence` 不能覆盖新位置。
- 原生 EPUB/PDF checkpoint 先同步写入 Reader Position Outbox，再合并为一次 Host 保存；Bookroom 卸载时会立刻提交尚未到期的 checkpoint，避免切换至对话或轨迹时定时器丢失位置。
- EPUB 阅读字号现作为 `epubFontScale` 与 CFI 一起保存并恢复；不再只保存 PDF 缩放，切换书房、轨迹或对话后字号会回到本书本会话的最后设置。
- 修正 EPUB 字号持久化的单位冲突：新记录以阅读器百分比（如 `110`）保存，旧版倍率（如 `1.1`）仍可启动并在恢复时转换，避免有效阅读位置令 Host 无法启动。
- MinerU 未配置时，上传 PDF 不再被标记为整本导入失败：原版 PDF 会以 `original-pdf` Revision 入库并可授权阅读；书库明确标示 AI 检索、引用和结构目录尚不可用。
- PDF.js Worker 实现现被收束进唯一 Client 发布物并以内联 Fake Worker 运行，Harness 单文件 ModuleLoader 下不再请求不存在的 `pdf.worker.mjs`；原版 PDF Canvas 与可选择 TextLayer 可正常渲染。
- 已持久化的 0.3.0 EPUB `legacy-block` 记录可安全读取并迁移；它不会再阻止 Host 启动，也不会让原版 EPUB 永久停留在禁止 CFI 写回的恢复状态。
- 原版 EPUB 在尚未获得引擎 CFI 前不会以 `legacy-block` 伪造新位置；首次可信 `relocated` 会同时提交 CFI 与当前字号。
- 新增浏览器根 `ctx.studyReaders` Registry、恢复协调器与 Reader Diagnostics。书房重挂载可先恢复最近可信 native locator，随后由 Host 权威记录确认；PDF/EPUB 恢复失败不会写回近似位置。
- Reader Diagnostics 现包含稳定的 native Locator 指纹；PDF 的顶部文字 checkpoint 还记录观测时的 scrollport 偏移，供真实浏览器验收比较同一文字锚点与同布局视口误差。
- PDF TextLayer 恢复会验证同一 `pageIndex + start/end + exact` 原文；选区矩形改为归一化页面坐标。EPUB 语义 Block 额外保留 XHTML `href` 与源码偏移，供后续 CFI Range 映射使用。
- 原版 PDF 的普通翻页和滚动也会从最上方可见的 PDF.js TextLayer 项建立去抖文字定位；不再要求读者先划选文字才可从同一原文位置恢复。
- PDF 选区的 `exact` 现始终从确定性 PageTextIndex 的 `[start,end)` 区间取得；跨 TextLayer span、元素边界或浏览器展示空白差异不再让保存文本与恢复校验文本不一致。
- EPUB 每个 Spine XHTML 文档的首标题现在都重启为独立的一级目录根节点；修正 Calibre 将文档开头样式为 `h2`/`h3` 时，后一章错误继承前一章标题路径的问题。
- EPUB 引擎生命周期现仅随原始文件 URL 变化；字号和 CFI 恢复在同一 native rendition 内执行，并以实例令牌丢弃已卸载文献的迟到恢复/导航结果。
- PDF.js 原版页不再因 Bookroom 状态回调身份变化而重复销毁、下载和渲染；滚动位置采集仅观察最新回调，不会成为引擎重建的触发条件。
- EPUB 引擎若规范化同一 CFI 的字符串表示，会以保存的原版文本见证验证恢复；没有文本见证时仍要求 CFI 完全相同，避免把近似位置宣称为精确恢复。
- 原版 EPUB 现在显式以归档格式打开 Host 的无扩展名资产 URL，并兼容 epub.js 的嵌套 CJS/ESM 导出；不再误判为相邻目录而停在空白正文。
- EPUB 初始显示与保存 CFI 恢复合并为同一次导航，避免默认章节显示在异步完成后覆盖精确文字位置。
- 浏览器发布物现在将 EPUB.js 与 PDF.js 的动态依赖收束到唯一的 `lib/client.js`；发布校验会拒绝引用未注册相对 CJS 分块的 Client 包，避免 Harness ModuleLoader 在运行时加载插件失败。
- EPUB Spine 现在会跳过 EPUB3 导航文档；若出版物错误地把全部正文都标为 `linear="no"`，解析器会回退到这些可读 XHTML 文档而不是报告空书。
- 原版 EPUB 的目录导航现在把逻辑章节解析为原始 Spine XHTML href，并调用 epub.js 跳转；恢复校验失败时冻结自动位置回写，直到用户下一次显式导航。
- 原版 PDF 的没有文字锚点的显式翻页使用 `pdf-page`（页级）位置；不再把新的原版 PDF 操作写成迁移专用的 `legacy-block`，同页已有 TextLayer 文字锚点时继续保留字符级位置。
- 分离阅读器的 `onPageNavigate` 与 `onVisiblePageChange`，避免恢复或滚动观察反向触发章节导航。
- 首轮 `passage` 研读由 Host 强制限制为诊断题、短反馈、提示、综合与引文；模型若在用户选项前提交费曼、图尔敏、评估或下一问会被拒绝，补救内容只能在后续 `answer` 请求中生成。
- 浏览器语义操作改为类型化 `executeStudyCommand`，以稳定 `commandId` 进入 Outbox；Host 映射并追加内部 `study/*` 事件。浏览器 Remote 不再接受原始事件名。
- 移除发布包的 `./src/*` 私有源码导出，外部 Profile 只依赖显式公开入口。

## 0.3.0

- 新增稳定 `ctx.studyMemory` Broker 与可热替换的 Durable Provider；会话工作区、驻留历史、内容记忆和变更审计独立于具体 StudyService 生命周期。
- 新增稳定、最小权限的 `ctx.studyAgent` Broker；所有模型可见 `study_*` 工具改为经 Broker 调用当前 Provider，不再直接绑定 `ctx.study`。
- 两个 Broker 增加 Generation Lease、in-flight 计数和异步排空；旧代 Disposer 不能注销新代 Provider，旧 Provider 关闭前会完成已接收操作，新调用立即路由到新代。
- 调整 Study 插件撤销顺序，卸载时先撤销并排空 Agent Provider，再停止具体服务和关闭 Storage Domain。
- 新增 Host 级 Session Workspace Snapshot：恢复选中文献/Revision、书库或阅读模式、目录折叠、伴读台、记忆范围与驻留状态；Lamport 式 `clientUpdatedAt` 防止旧会话延迟快照以及与驻留点击等时钟的快照回滚新状态。
- 新增 `session` 与 `source` 两种内容记忆范围。来源级记忆可在仍有文献授权的会话间共享；Provider 校验 ID/正文/备注/标签边界，Agent Context Pack 精确受 `maxChars` 限制并按不可信 JSONL 处理。
- 浏览器新增稳定 `memoryId` 的记忆 Outbox，点击“记忆”后先本地持久化，再向 Host 幂等重放；刷新、断网和会话切换不丢失操作。
- 新增 Session Epoch 隔离，阻止旧会话的事件回放、文献请求、Agent/复盘结果和记忆请求写入当前会话；延迟阅读位置在切换时回到原会话 Outbox；Library Import 继续在 Host 执行但旧进度回调不再污染新会话。
- 新增长期记忆面板、记忆范围切换、删除入口、会话驻留按钮和历史会话列表。
- 修复 Answer 认知请求缺少 `question`/`userAnswer` 时仍可能通过验证的问题。
- 修复源删除与记忆/工作区并发写入的锁序问题；删除 Source 会清理记忆与所有工作区中的旧 Source/Revision 锚点。
- 增加点击级 React 回归：划选后点击记忆、会话切换后恢复、旧会话晚到回放隔离、阅读位置回写原会话 Outbox、会话驻留按钮。
- 增加 Host/Broker 回归：重启后工作区恢复、跨会话记忆可见性、旧快照拒绝、Source 清理、无效 Answer 拒绝、Memory/Agent Provider 热替换与在途排空。

## 0.2.0

- 增加 EPUB 2/3 本地导入：OPF Manifest、Spine、EPUB3 Nav、EPUB2 NCX、XHTML 语义 Block 与图片资源。
- EPUB XHTML 从正则匹配升级为 HTML5 DOM 解析，支持 Calibre 常见的叶级容器正文与类名标题，避免整章正文位于 `div` 时只导入标题和图片。
- PDF 原文件持久化并通过同源、Revision 限定的 Range 路由呈现；结构层继续使用 MinerU Block。
- 统一 PDF/EPUB 的 `StudyBlock`、Outline、Citation 和 Source/Revision 格式元数据。
- 阅读器改为 Block-aware：选区返回真实 BlockId；高亮、书签、卡点改为显式操作。
- 打通费曼、图尔敏、苏格拉底、解释前校准、复习卡片和持久化复盘闭环；复盘工具改为按当前 Session/Source/Revision 折叠权威事件流。
- 伴读生成改为当前会话 Agent 的正常 Turn，严格继承用户选择的 Provider/Model、Preset、权限和工具；Agent 通过 `study_analyze` 取证并用 `study_submit_cognitive_probe` 提交可校验的六选项认知分叉，实际模型路由随结果留痕。
- 认知流程改为诊断首轮与选择后补救轮：首次答案锁定，解释、评估和下一问只在读者选择后生成；不同 Request 的认知结果不再隐式拼接。
- `study_analyze` 增加绑定 Agent Turn 的持久 Receipt，完成工具必须回传 Receipt；稳定 Inbox Message ID 与可配置的登记重试修复请求落库与 Follow-up 投递之间的中断窗口，完成重试直接返回已有结果。
- 浏览器 Remote 改为明确的可写事件白名单，并统一验证 Source/Revision/Block/Page/选中文字；Host/Agent 所有的导入、认知结果和复盘事件不能由客户端伪造。
- 客户端增加持久 Pending Outbox Overlay 和 `afterSeq` 增量回放；并行认知请求各自拥有取消与超时控制，服务端回放不再覆盖未确认操作。
- Study Event 增加运行时 Schema、Session 串行追加和 `clientEventId` 幂等校验。
- 所有研读数据按 Source + Revision 分区，避免重解析后锚点串用。
- UI 改用平台语义令牌、响应式布局和引用计数式可撤销样式注入；`reading` 与 `debug` Preset 在原始“对话”和“轨迹”之外增加“书房”视图，其他 Preset 不显示书房栏目。
- 增加统一书库与会话级显式授权层：导入不自动授权，Agent 与浏览器只能发现和读取当前会话已获授权的书籍。
- 书库区分各导入阶段与终态失败，显示失败码和原因；撤销研读授权后，当前会话立即失去访问权限。
- 文件选择器同时声明 EPUB 扩展名与 `application/epub+zip`，避免系统文件选择器只按 MIME 分类时隐藏 EPUB。
- 增加 ZIP/EPUB、原始资源、SVG、Byte Range 与导入恢复的边界保护。
- 修正 MinerU v4 批量轮询的嵌套 `extract_result`、`state`、`extract_progress` 与 `err_msg` 解析，并重试短暂的 `waiting-file` 状态。
- 上传原件落盘后由 Host 后台任务继续 EPUB 解析、PDF 拆分和 MinerU 提交；浏览器可并行发起导入并分别查看状态。
- 增加完整书名确认的数据库级联删除；Agent 删除工具需要额外审批，活动导入期间拒绝删除。
- 修正 MinerU 3.x `content_list_v2.json` 按页二维数组被误判为缺少 `content` 的问题，并解析结构化标题、段落、公式、表格、图片、代码与列表内容。
- “书房”和“轨迹”不再显示共享对话输入框；书房正文成为单一主滚动区，并支持在页首/页尾继续滚动切换相邻页且防止一次手势连续跳页。
- EPUB 结构层改为增量载入全书的连续阅读面；目录和前后按钮定位 Spine 章节，滚动位置同步章节指示，不再让滚轮只能整章切换。
- 书房只接管自己的直接视图宿主并固定两层工具栏；左侧目录、中间书页和右侧伴读台独立滚动，正文只更新章节高亮而不驱动目录滚动，EPUB 不再显示伪分页式章节按钮。
- PDF 与 EPUB 结构层增加基于完整 Revision 索引的全书检索、命中计数、前后结果导航和正文命中标记；PDF 结果可跳转到尚未载入的物理页。
- 增加可发现的 `probe:import` 真实导入探针，支持 PDF/EPUB、可关联 Agent Session，并从诊断输出中移除上传凭据。
- 允许删除尚未开始上传的书库记录；拆分、解析、下载和索引中的任务仍受活动导入保护。
