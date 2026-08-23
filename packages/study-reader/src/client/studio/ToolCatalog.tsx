/** Read-only inspector projected from the exact runtime Tool declarations. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ToolDescriptorView } from '../../study/types.ts'
import type { StudyRemote } from '../remote.ts'
import { useBilingualText, type BilingualText } from '../StudyLocale.tsx'

export function ToolCatalog(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined }) {
  const b = useBilingualText()
  const [tools, setTools] = useState<readonly ToolDescriptorView[]>([])
  const [selectedName, setSelectedName] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  useEffect(() => {
    let alive = true
    setTools([]); setSelectedName(undefined); setFailure(undefined)
    if (props.studyRemote === undefined) return
    void props.studyRemote.listToolCatalog({ sessionId: props.sessionId }).then(result => {
      if (!alive) return
      if (!result.ok) { setFailure(result.error.message); return }
      setTools(result.value)
      setSelectedName(result.value[0]?.name)
    }).catch(error => { if (alive) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { alive = false }
  }, [props.sessionId, props.studyRemote])
  const categories = useMemo(() => [...new Set(tools.map(tool => tool.category))].sort(), [tools])
  const visibleTools = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return tools.filter(tool => category === 'all' || tool.category === category).filter(tool => needle === '' || `${tool.name}\n${tool.title}\n${tool.description}`.toLocaleLowerCase().includes(needle))
  }, [category, query, tools])
  const selected = tools.find(tool => tool.name === selectedName)
  const display = (tool: ToolDescriptorView) => b(tool.title, tool.localized?.en.title ?? tool.title)
  return <section className="dsh-tool-catalog" aria-label="Tools">
    <aside className="dsh-tool-list"><header><h1>Tools</h1><p>{b('查看助手可用于文献阅读的能力与权限边界。', 'Inspect the assistant’s document capabilities and permission boundaries.')}</p></header>
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      <label className="dsh-tool-search">{b('查找 Tools', 'Find tools')}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder={b('名称、用途或说明', 'Name, purpose, or description')} /></label>
      <label className="dsh-tool-filter">{b('分类', 'Category')}<select value={category} onChange={event => setCategory(event.currentTarget.value)}><option value="all">{b('全部', 'All')}</option>{categories.map(item => <option value={item} key={item}>{item}</option>)}</select></label>
      <p className="dsh-tool-count">{visibleTools.length} / {tools.length} Tools</p>
      {visibleTools.map(tool => <button type="button" key={tool.name} aria-current={tool.name === selectedName ? 'page' : undefined} onClick={() => { setSelectedName(tool.name) }}>
        <strong>{display(tool)}</strong><small>{tool.name}</small><span>{tool.enabledInCurrentProfile ? b('当前可用', 'Available') : b('当前未启用', 'Disabled')} · {riskLabel(tool.risk, b)}</span>
      </button>)}
      {visibleTools.length === 0 && failure === undefined ? <p role="status">{b('没有匹配的 Tool。', 'No matching tools.')}</p> : null}
    </aside>
    <article className="dsh-tool-detail">{selected === undefined ? <p>{b('正在读取 Tool 信息…', 'Loading tool information…')}</p> : <ToolDetail tool={selected} />}</article>
  </section>
}

function ToolDetail({ tool }: { readonly tool: ToolDescriptorView }) {
  const b = useBilingualText()
  const localized = tool.localized?.en
  const english = b('zh', 'en') === 'en'
  return <><header><div><h1>{english ? localized?.title ?? tool.title : tool.title}</h1><p>{tool.name}</p></div><span>{riskLabel(tool.risk, b)}</span></header>
    <p className="dsh-tool-description">{english ? localized?.effectiveDescription ?? tool.effectiveDescription : tool.effectiveDescription}</p>
    <DetailSection title={b('调用逻辑', 'Invocation logic')}><h3>{b('什么时候调用', 'When to use')}</h3><List items={english ? localized?.whenToUse ?? tool.whenToUse : tool.whenToUse} /><h3>{b('什么时候不调用', 'When not to use')}</h3><List items={english ? localized?.whenNotToUse ?? tool.whenNotToUse : tool.whenNotToUse} /><h3>{b('后续动作', 'Next actions')}</h3><List items={english ? localized?.nextActions ?? tool.nextActions : tool.nextActions} /><p><strong>{b('来源解析：', 'Source resolution:')}</strong>{english ? localized?.sourceResolution ?? tool.sourceResolution : tool.sourceResolution}</p></DetailSection>
    <DetailSection title={b('安全合同', 'Safety contract')}><dl><div><dt>{b('风险', 'Risk')}</dt><dd>{tool.risk}</dd></div><div><dt>{b('持久化副作用', 'Persistent side effects')}</dt><dd>{tool.sideEffects}</dd></div><div><dt>{b('所需能力', 'Required capabilities')}</dt><dd>{tool.requiredCapabilities.join(', ') || b('无', 'None')}</dd></div></dl></DetailSection>
    <DetailSection title={b('范围限制', 'Limits')}><dl>{Object.entries(tool.limits).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></DetailSection>
    <DetailSection title={b('实现链', 'Implementation chain')}><ol>{tool.implementationChain.map(item => <li key={item}>{item}</li>)}</ol></DetailSection>
    <details><summary>{b('输入 Schema', 'Input schema')}</summary><pre>{tool.parametersJson}</pre></details>
    <details><summary>{b('输出 Schema', 'Output schema')}</summary><pre>{tool.outputJson}</pre></details>
    <p className="dsh-tool-hash">Schema SHA-256 <code>{tool.schemaHash}</code></p>
  </>
}

function riskLabel(risk: ToolDescriptorView['risk'], b: BilingualText): string {
  return risk === 'read' ? b('只读', 'Read only') : risk === 'navigate' ? b('导航', 'Navigation') : b('写入', 'Write')
}

function DetailSection(props: { readonly title: string; readonly children: ReactNode }) {
  return <section><h2>{props.title}</h2>{props.children}</section>
}

function List({ items }: { readonly items: readonly string[] }) {
  return <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
}
