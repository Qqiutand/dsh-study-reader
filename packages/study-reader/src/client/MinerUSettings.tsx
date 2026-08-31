/** MinerU connection profiles and credential settings. */

import { useCallback, useEffect, useState } from 'react'
import type { CredentialInfo, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderConnectionView } from '../study/types.ts'
import type { ProviderConnectionTestResult } from '../studio/types.ts'
import type { StudyRemote } from './remote.ts'
import { MINERU_SETTINGS_CSS, minerUSettingsClass as css } from './MinerUSettings.css.ts'
import { useBilingualText } from './StudyLocale.tsx'

const MINERU_API_KEY = 'MINERU_API_KEY'
const OFFICIAL_ENDPOINT = 'https://mineru.net'
const LOCAL_ENDPOINT = 'http://127.0.0.1:8000'

export interface MinerUSettingsProps {
  readonly credentials: {
    readonly describe: (refs: string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
    readonly set: (ref: string, value: string) => Promise<RemoteResult<void>>
  } | undefined
  readonly studyRemote?: StudyRemote
  readonly sessionId?: string
}

type CredentialState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly configured: boolean; readonly writable: boolean; readonly source?: string }
  | { readonly phase: 'failed'; readonly message: string }

export function normalizeMinerUApiKey(raw: string): string | undefined {
  const value = raw.trim()
  return value.length > 0 && /^[\x21-\x7E]+$/u.test(value) ? value : undefined
}

function newConnection(providerId: string): ProviderConnectionView {
  return {
    id: '', providerId, kind: 'mineru', displayName: '', builtin: false, active: false,
    credentialRef: MINERU_API_KEY, endpoint: OFFICIAL_ENDPOINT, enabled: true, version: 0, model: 'vlm',
    options: { apiMode: 'cloud-v4', localBackend: 'pipeline', language: 'ch', requestTimeoutMs: 30000, enableTable: true, enableFormula: true, isOcr: false },
  }
}

/** Render durable MinerU connection profiles without ever reading a secret value back. */
export function MinerUSettings({ credentials, studyRemote, sessionId }: MinerUSettingsProps) {
  const b = useBilingualText()
  const [credential, setCredential] = useState<CredentialState>({ phase: 'loading' })
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string>()
  const [connections, setConnections] = useState<readonly ProviderConnectionView[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [connectionDraft, setConnectionDraft] = useState<ProviderConnectionView>()
  const [creating, setCreating] = useState(false)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [connectionError, setConnectionError] = useState<string>()
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult>()

  useEffect(() => {
    const selector = 'style[data-plugin-css="ui-study/mineru-settings"]'
    let tag = document.querySelector<HTMLStyleElement>(selector)
    if (tag === null) {
      tag = document.createElement('style')
      tag.dataset.plugin = '@deepseek-ai/dsh-client-ui-study'
      tag.dataset.pluginCss = 'ui-study/mineru-settings'
      tag.textContent = MINERU_SETTINGS_CSS
      document.head.appendChild(tag)
    }
    tag.dataset.pluginRefs = String(Number(tag.dataset.pluginRefs ?? '0') + 1)
    return () => {
      if (tag === null) return
      const refs = Number(tag.dataset.pluginRefs ?? '1') - 1
      if (refs <= 0) tag.remove()
      else tag.dataset.pluginRefs = String(refs)
    }
  }, [])

  const refresh = useCallback(async (preferredId?: string): Promise<void> => {
    setCredential({ phase: 'loading' })
    const tasks: Promise<void>[] = []
    tasks.push((async () => {
      if (credentials === undefined) {
        setCredential({ phase: 'failed', message: b('当前 DSH 未提供凭据管理接口；本地 Docker 服务不受影响。', 'This DSH host does not expose credential management. Local Docker remains available.') })
        return
      }
      try {
        const response = await credentials.describe([MINERU_API_KEY])
        if (!response.ok) { setCredential({ phase: 'failed', message: response.error.message }); return }
        const view = response.value[MINERU_API_KEY]
        setCredential({ phase: 'ready', configured: view?.configured === true, writable: view?.writable !== false, ...(view?.source === undefined ? {} : { source: view.source }) })
      } catch (error) {
        setCredential({ phase: 'failed', message: error instanceof Error ? error.message : b('无法连接到凭据服务', 'Cannot connect to the credential service') })
      }
    })())
    if (studyRemote !== undefined && sessionId !== undefined) {
      tasks.push((async () => {
        try {
          const result = await studyRemote.listProviderConnections({ sessionId })
          if (!result.ok) throw new Error(result.error.message)
          const next = result.value
          setConnections(next)
          const selected = next.find(item => item.id === preferredId) ?? next.find(item => item.active) ?? next[0]
          setSelectedId(selected?.id)
          setConnectionDraft(selected)
          setCreating(false)
          setConnectionError(undefined)
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : b('无法读取 MinerU 连接配置', 'Cannot load MinerU connections'))
        }
      })())
    }
    await Promise.all(tasks)
  }, [b, credentials, sessionId, studyRemote])

  useEffect(() => { void refresh() }, [refresh])

  const saveKey = async (): Promise<void> => {
    const value = normalizeMinerUApiKey(keyDraft)
    if (value === undefined) { setKeyError(b('密钥必须是没有空格的可打印 ASCII 字符。', 'The key must contain printable ASCII characters without spaces.')); return }
    setKeyBusy(true); setKeyError(undefined)
    try {
      if (credentials === undefined) throw new Error(b('当前 DSH 未提供凭据管理接口。', 'This DSH host does not expose credential management.'))
      const response = await credentials.set(MINERU_API_KEY, value)
      if (!response.ok) throw new Error(response.error.message)
      setKeyDraft('')
      await refresh()
    } catch (error) { setKeyError(error instanceof Error ? error.message : b('保存密钥失败。', 'Failed to save the key.')) } finally { setKeyBusy(false) }
  }

  const persistConnection = async (activate: boolean): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || connectionDraft === undefined) return
    setConnectionBusy(true); setConnectionError(undefined); setTestResult(undefined)
    try {
      const result = await studyRemote.saveProviderConnection({
        sessionId, commandId: `provider:save:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
        providerId: connectionDraft.providerId, ...(creating ? {} : { connectionId: connectionDraft.id }),
        displayName: connectionDraft.displayName, expectedVersion: creating ? 0 : connectionDraft.version,
        endpoint: connectionDraft.endpoint, enabled: connectionDraft.enabled,
        ...(connectionDraft.model === undefined ? {} : { model: connectionDraft.model }),
        nonSecretConfig: connectionDraft.options, activate,
      })
      if (!result.ok) throw new Error(result.error.message)
      await refresh(result.value.id)
    } catch (error) { setConnectionError(error instanceof Error ? error.message : String(error)) } finally { setConnectionBusy(false) }
  }

  const deleteConnection = async (): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || connectionDraft === undefined || creating) return
    setConnectionBusy(true); setConnectionError(undefined)
    try {
      const result = await studyRemote.deleteProviderConnection({ sessionId, commandId: `provider:delete:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, connectionId: connectionDraft.id, expectedVersion: connectionDraft.version })
      if (!result.ok) throw new Error(result.error.message)
      setSelectedId(undefined)
      await refresh()
    } catch (error) { setConnectionError(error instanceof Error ? error.message : String(error)) } finally { setConnectionBusy(false) }
  }

  const testConnection = async (): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || connectionDraft === undefined || !connectionDraft.active) return
    setConnectionBusy(true); setConnectionError(undefined); setTestResult(undefined)
    try {
      const result = await studyRemote.testProviderConnection({ sessionId, providerId: connectionDraft.providerId })
      if (!result.ok) throw new Error(result.error.message)
      setTestResult(result.value)
    } catch (error) { setConnectionError(error instanceof Error ? error.message : String(error)) } finally { setConnectionBusy(false) }
  }

  const localDocker = connectionDraft?.options.apiMode === 'local-docker'
  const readOnlyKey = credential.phase === 'ready' && !credential.writable
  return <section className={css.page} aria-label={b('服务与密钥', 'Services and credentials')}>
    <div className={css.heading}>
      <p className={css.eyebrow}>PROVIDER CONNECTIONS</p><h2>{b('服务与密钥', 'Services and credentials')}</h2>
      <p>{b('保留官方云端连接，也可以添加本地 Docker 或其他 MinerU 地址。密钥由 Harness Credential Service 保存，不会写入会话或提示内容。', 'Keep the official cloud connection or add local Docker and custom MinerU endpoints. Secrets are stored by Harness Credential Service and never written into sessions or prompts.')}</p>
    </div>
    <div className={css.layout}>
      <aside className={css.connectionList} aria-label={b('MinerU 连接', 'MinerU connections')}>
        <header><div><h3>{b('MinerU 连接', 'MinerU connections')}</h3><p>{b(`${connections.length} 项配置`, `${connections.length} connections`)}</p></div><button type="button" onClick={() => { const providerId = connections[0]?.providerId ?? 'mineru'; setCreating(true); setSelectedId(undefined); setConnectionDraft({ ...newConnection(providerId), displayName: b('新连接', 'New connection') }); setConnectionError(undefined); setTestResult(undefined) }}>{b('新增连接', 'New connection')}</button></header>
        <div className={css.connectionRows}>
          {connections.map(item => <button key={item.id} type="button" aria-current={!creating && item.id === selectedId ? 'page' : undefined} onClick={() => { setCreating(false); setSelectedId(item.id); setConnectionDraft(item); setConnectionError(undefined); setTestResult(undefined) }}>
            <strong>{item.displayName}</strong><span>{item.options.apiMode === 'local-docker' ? b('本地 Docker', 'Local Docker') : b('云端 v4', 'Cloud v4')} · {item.endpoint}</span><small>{item.active ? b('正在用于新导入', 'Active for new imports') : item.builtin ? b('官方默认', 'Official default') : b('未启用', 'Inactive')}</small>
          </button>)}
        </div>
      </aside>
      <div className={css.detail}>
        {connectionDraft === undefined ? <p>{b('请选择或新增一个连接。', 'Select or add a connection.')}</p> : <div className={css.card}>
          <div className={css.cardHead}><div><h3>{creating ? b('新增 MinerU 连接', 'New MinerU connection') : connectionDraft.displayName}</h3><p>{connectionDraft.builtin ? b('内置官方配置', 'Built-in official configuration') : b('自定义配置', 'Custom configuration')}</p></div><span className={connectionDraft.active ? css.configured : css.unconfigured}>{connectionDraft.active ? b('正在使用', 'Active') : b('未启用', 'Inactive')}</span></div>
          {connectionDraft.active && connectionDraft.health !== undefined ? <dl><div><dt>Provider</dt><dd>{connectionDraft.providerId}</dd></div><div><dt>Endpoint</dt><dd>{connectionDraft.endpoint}</dd></div><div><dt>{b('模型', 'Model')}</dt><dd>{connectionDraft.model ?? b('默认', 'Default')}</dd></div><div><dt>{b('健康状态', 'Health')}</dt><dd>{connectionDraft.health.state} · {new Date(connectionDraft.health.checkedAt).toLocaleTimeString()}</dd></div></dl> : null}
          <fieldset>
            <legend>{b('连接配置', 'Connection settings')}</legend>
            <label className={css.label}>{b('配置名称', 'Name')}<input className={css.input} value={connectionDraft.displayName} onChange={event => setConnectionDraft({ ...connectionDraft, displayName: event.currentTarget.value })} /></label>
            <label className={css.label}>{b('服务类型', 'Service type')}<select className={css.input} value={String(connectionDraft.options.apiMode ?? 'cloud-v4')} onChange={event => { const mode = event.currentTarget.value; setConnectionDraft({ ...connectionDraft, endpoint: mode === 'local-docker' && connectionDraft.endpoint === OFFICIAL_ENDPOINT ? LOCAL_ENDPOINT : mode === 'cloud-v4' && connectionDraft.endpoint === LOCAL_ENDPOINT ? OFFICIAL_ENDPOINT : connectionDraft.endpoint, options: { ...connectionDraft.options, apiMode: mode } }) }}><option value="cloud-v4">{b('MinerU 云端 v4', 'MinerU Cloud v4')}</option><option value="local-docker">{b('本地 Docker（mineru-api）', 'Local Docker (mineru-api)')}</option></select></label>
            <label className={css.label}>{b('服务地址', 'Endpoint')}<input className={css.input} value={connectionDraft.endpoint} placeholder={localDocker ? LOCAL_ENDPOINT : OFFICIAL_ENDPOINT} onChange={event => setConnectionDraft({ ...connectionDraft, endpoint: event.currentTarget.value })} /></label>
            {localDocker ? <label className={css.label}>{b('本地后端', 'Local backend')}<select className={css.input} value={String(connectionDraft.options.localBackend ?? 'pipeline')} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, localBackend: event.currentTarget.value } })}><option value="pipeline">pipeline</option><option value="vlm-engine">vlm-engine</option><option value="hybrid-engine">hybrid-engine</option></select></label> : <label className={css.label}>{b('模型', 'Model')}<select className={css.input} value={connectionDraft.model ?? 'pipeline'} onChange={event => setConnectionDraft({ ...connectionDraft, model: event.currentTarget.value })}><option value="pipeline">pipeline</option><option value="vlm">vlm</option><option value="MinerU-HTML">MinerU-HTML</option></select></label>}
            <div className={css.formGrid}><label className={css.label}>{b('默认语言', 'Default language')}<input className={css.input} value={String(connectionDraft.options.language ?? 'ch')} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, language: event.currentTarget.value } })} /></label><label className={css.label}>{b('请求超时（ms）', 'Request timeout (ms)')}<input className={css.input} type="number" min={1} max={300000} value={Number(connectionDraft.options.requestTimeoutMs ?? 30000)} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, requestTimeoutMs: event.currentTarget.valueAsNumber } })} /></label></div>
            <div className={css.checks}><label><input type="checkbox" checked={Boolean(connectionDraft.options.enableTable)} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, enableTable: event.currentTarget.checked } })} /> {b('表格识别', 'Tables')}</label><label><input type="checkbox" checked={Boolean(connectionDraft.options.enableFormula)} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, enableFormula: event.currentTarget.checked } })} /> {b('公式识别', 'Formulas')}</label><label><input type="checkbox" checked={Boolean(connectionDraft.options.isOcr)} onChange={event => setConnectionDraft({ ...connectionDraft, options: { ...connectionDraft.options, isOcr: event.currentTarget.checked } })} /> {b('默认 OCR', 'OCR by default')}</label><label><input type="checkbox" checked={connectionDraft.enabled} onChange={event => setConnectionDraft({ ...connectionDraft, enabled: event.currentTarget.checked })} /> {b('接受新任务', 'Accept new jobs')}</label></div>
          </fieldset>
          {!localDocker ? <section className={css.keySection}><h4>MinerU API Key</h4><input className={css.input} type="password" autoComplete="new-password" value={keyDraft} disabled={keyBusy || readOnlyKey} placeholder={credential.phase === 'ready' && credential.configured ? b('已保存；输入新密钥即可替换', 'Saved; enter a new key to replace it') : 'MinerU API Key'} onChange={event => setKeyDraft(event.currentTarget.value)} /><p className={css.hint}>{readOnlyKey ? b(`密钥由 ${credential.source === 'env' ? '启动环境变量' : '只读凭据来源'} 提供。`, `The key comes from a ${credential.source === 'env' ? 'startup environment variable' : 'read-only credential source'}.`) : b('所有云端连接共用这个安全凭据；本地 Docker 不需要密钥。', 'All cloud connections share this protected credential. Local Docker does not require a key.')}</p>{credential.phase === 'failed' ? <p className={css.error} role="alert">{b('无法读取密钥状态：', 'Cannot read credential status: ')}{credential.message}</p> : null}{keyError === undefined ? null : <p className={css.error} role="alert">{keyError}</p>}<div className={css.actions}><button className={css.refresh} type="button" disabled={keyBusy || readOnlyKey || keyDraft.trim() === ''} onClick={() => void saveKey()}>{credential.phase === 'ready' && credential.configured ? b('更新密钥', 'Update key') : b('保存密钥', 'Save key')}</button></div></section> : <p className={css.hint}>{b('本地 Docker 服务不需要 API Key；文件由 DSH Host 直接上传到该地址。', 'Local Docker does not require an API key; DSH Host uploads files directly to this endpoint.')}</p>}
          {connectionError === undefined ? null : <p className={css.error} role="alert">{connectionError}</p>}
          {testResult === undefined ? null : <p role="status">{testResult.ok ? b('连接可用', 'Connection available') : b('连接不可用', 'Connection unavailable')} · {testResult.providerStatus} · {testResult.latencyMs} ms · {testResult.message}</p>}
          <div className={css.actions}><button className={css.save} type="button" disabled={connectionBusy || connectionDraft.displayName.trim() === '' || connectionDraft.endpoint.trim() === ''} onClick={() => void persistConnection(connectionDraft.active)}>{creating ? b('保存连接', 'Save connection') : b('保存修改', 'Save changes')}</button>{!connectionDraft.active ? <button className={css.refresh} type="button" disabled={connectionBusy} onClick={() => void persistConnection(true)}>{b('设为当前连接', 'Make active')}</button> : <button className={css.refresh} type="button" disabled={connectionBusy} onClick={() => void testConnection()}>{b('测试连接', 'Test connection')}</button>}{!creating && !connectionDraft.builtin && !connectionDraft.active ? <button className={css.danger} type="button" disabled={connectionBusy} onClick={() => void deleteConnection()}>{b('删除', 'Delete')}</button> : null}</div>
        </div>}
      </div>
    </div>
  </section>
}
