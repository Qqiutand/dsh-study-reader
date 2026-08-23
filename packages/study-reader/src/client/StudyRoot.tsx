/**
 * Plugin-owned Study workspace root. The controller follows the public
 * Session list/current projections, mounts one body child for a study-capable
 * Session, and never subscribes to or projects Agent conversation state.
 * @module @deepseek-ai/dsh-study-reader/client/StudyRoot
 */

import { createRoot, type Root } from 'react-dom/client'
import type { ISessions, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { StudioShell } from './studio/StudioShell.tsx'
import { ClientErrorBoundary } from './ClientErrorBoundary.tsx'
import { StudyLocaleProvider, useStudyLocale, type StudyLocaleFace } from './StudyLocale.tsx'
import type { StudyRemote } from './remote.ts'
import type { MinerUSettingsProps } from './MinerUSettings.tsx'
import { STUDY_ROOT_CSS, studyRootClass as css } from './StudyRoot.css.ts'

const ROOT_ATTRIBUTE = 'data-dsh-study-root'
const STYLE_ATTRIBUTE = 'data-dsh-study-root-style'
const STORAGE_KEY = 'dsh.study-reader.surface.v1'
const STUDY_PRESETS = new Set(['reading'])

/** Top-level surface owned by the Study plugin for one Session. */
export type StudySurface = 'chat' | 'study'

/** Active Session facts required to mount the plugin-owned root. */
export interface StudyActivation {
  readonly sessionId: SessionId
  readonly preset: string
  readonly blank: boolean
}

/** Dependencies retained by the Study root controller. */
export interface StudyRootDependencies {
  readonly sessions: Pick<ISessions, 'list' | 'currentProvideInfo'>
  readonly studyRemote: StudyRemote | undefined
  readonly credentialsApi?: MinerUSettingsProps['credentials']
  readonly document?: Document
  readonly locale: StudyLocaleFace
}

interface MountedStudyRoot extends StudyActivation {
  readonly container: HTMLDivElement
  readonly style: HTMLStyleElement
  readonly root: Root
  surface: StudySurface
}

/** Resolve whether the current Session owns Study UI. */
export function resolveStudyActivation(snapshot: SessionListState, current = snapshot.current): StudyActivation | undefined {
  if (current === undefined) return undefined
  const summary = snapshot.byId[current]
  const preset = summary?.agentPreset
  if (summary === undefined || preset === undefined || !STUDY_PRESETS.has(preset)) return undefined
  return { sessionId: current, preset, blank: summary.blank }
}

function readStoredSurfaces(storage: Storage | undefined): Record<string, StudySurface> {
  if (storage === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, StudySurface> = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (value === 'chat' || value === 'study') result[sessionId] = value
      // One-way migration from the removed plugin trace surface.
      else if (value === 'trace') result[sessionId] = 'study'
    }
    return result
  } catch {
    return {}
  }
}

function writeStoredSurfaces(storage: Storage | undefined, value: Readonly<Record<string, StudySurface>>): void {
  if (storage === undefined) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Browser privacy modes may reject persistence; process-local state remains valid.
  }
}

/** Owns the one optional React root mounted directly under document.body. */
export class StudyRootController {
  private readonly document: Document
  private readonly surfaces: Record<string, StudySurface>
  private mounted: MountedStudyRoot | undefined
  private unsubscribeList: (() => void) | undefined
  private unsubscribeCurrent: (() => void) | undefined
  private started = false

  constructor(private readonly deps: StudyRootDependencies) {
    this.document = deps.document ?? document
    this.surfaces = readStoredSurfaces(this.document.defaultView?.localStorage)
  }

  start(): () => void {
    if (this.started) throw new Error('StudyRootController already started')
    this.started = true
    this.synchronizeCurrent()
    this.unsubscribeList = this.deps.sessions.list.subscribe(() => { this.synchronizeCurrent() })
    this.unsubscribeCurrent = this.deps.sessions.currentProvideInfo.subscribe(() => { this.synchronizeCurrent() })
    return () => { this.dispose() }
  }

  dispose(): void {
    if (!this.started) return
    this.started = false
    this.unsubscribeList?.()
    this.unsubscribeList = undefined
    this.unsubscribeCurrent?.()
    this.unsubscribeCurrent = undefined
    this.deactivate()
  }

  private synchronizeCurrent(): void {
    const current = this.deps.sessions.currentProvideInfo.getSnapshot().sessionId
    const activation = resolveStudyActivation(this.deps.sessions.list.getSnapshot(), current)
    if (activation === undefined) {
      this.deactivate()
      return
    }
    if (this.mounted === undefined) {
      this.activate(activation)
      return
    }
    if (this.mounted.sessionId !== activation.sessionId) {
      this.mounted = { ...this.mounted, ...activation, surface: this.surfaceFor(activation) }
      this.render()
      return
    }
    if (this.mounted.preset !== activation.preset || this.mounted.blank !== activation.blank) {
      this.mounted = { ...this.mounted, ...activation }
      this.render()
    }
  }

  private activate(activation: StudyActivation): void {
    const style = this.document.createElement('style')
    style.setAttribute(STYLE_ATTRIBUTE, '')
    style.textContent = STUDY_ROOT_CSS
    this.document.head.appendChild(style)
    const container = this.document.createElement('div')
    container.setAttribute(ROOT_ATTRIBUTE, '')
    this.document.body.appendChild(container)
    this.mounted = {
      ...activation,
      container,
      style,
      root: createRoot(container),
      surface: this.surfaceFor(activation),
    }
    this.render()
  }

  private deactivate(): void {
    const mounted = this.mounted
    this.mounted = undefined
    if (mounted === undefined) return
    mounted.root.unmount()
    mounted.container.remove()
    mounted.style.remove()
  }

  private surfaceFor(activation: StudyActivation): StudySurface {
    const remembered = this.surfaces[activation.sessionId]
    if (remembered !== undefined) return remembered
    const initial = activation.blank ? 'study' : 'chat'
    this.surfaces[activation.sessionId] = initial
    writeStoredSurfaces(this.document.defaultView?.localStorage, this.surfaces)
    return initial
  }

  private selectSurface(surface: StudySurface): void {
    const mounted = this.mounted
    if (mounted === undefined || mounted.surface === surface) return
    mounted.surface = surface
    this.surfaces[mounted.sessionId] = surface
    writeStoredSurfaces(this.document.defaultView?.localStorage, this.surfaces)
    this.render()
  }

  private render(): void {
    const mounted = this.mounted
    if (mounted === undefined) return
    mounted.container.dataset.sessionId = mounted.sessionId
    mounted.container.dataset.preset = mounted.preset
    mounted.container.dataset.surface = mounted.surface
    mounted.root.render(<StudyClientRoot
      sessionId={mounted.sessionId}
      preset={mounted.preset}
      surface={mounted.surface}
      studyRemote={this.deps.studyRemote}
      credentialsApi={this.deps.credentialsApi}
      locale={this.deps.locale}
      onSurfaceChange={surface => { this.selectSurface(surface) }}
    />)
  }
}

interface StudyClientRootProps {
  readonly sessionId: string
  readonly preset: string
  readonly surface: StudySurface
  readonly studyRemote: StudyRemote | undefined
  readonly credentialsApi: MinerUSettingsProps['credentials']
  readonly onSurfaceChange: (surface: StudySurface) => void
  readonly locale: StudyLocaleFace
}

function StudyClientRoot(props: StudyClientRootProps) {
  return <StudyLocaleProvider locale={props.locale}><LocalizedStudyClientRoot {...props} /></StudyLocaleProvider>
}

function LocalizedStudyClientRoot(props: StudyClientRootProps) {
  const t = useStudyLocale()
  const overlayOpen = props.surface === 'study'
  return <div className={css.root} data-study-preset={props.preset}>
    <nav className={css.switcher} aria-label={t('surface.switcher')}>
      <SurfaceButton surface="chat" current={props.surface} onSelect={props.onSurfaceChange}>{t('surface.chat')}</SurfaceButton>
      <SurfaceButton surface="study" current={props.surface} onSelect={props.onSurfaceChange}>{t('surface.study')}</SurfaceButton>
    </nav>
    <div className={css.overlay} hidden={!overlayOpen}>
      <div className={css.workspace}>
        <ClientErrorBoundary resetKey={props.sessionId} t={t}>
          <StudioShell sessionId={props.sessionId} studyRemote={props.studyRemote} credentialsApi={props.credentialsApi} />
        </ClientErrorBoundary>
      </div>
    </div>
  </div>
}

function SurfaceButton(props: {
  readonly surface: StudySurface
  readonly current: StudySurface
  readonly onSelect: (surface: StudySurface) => void
  readonly children: string
}) {
  return <button type="button" aria-pressed={props.current === props.surface} onClick={() => { props.onSelect(props.surface) }}>
    {props.children}
  </button>
}
