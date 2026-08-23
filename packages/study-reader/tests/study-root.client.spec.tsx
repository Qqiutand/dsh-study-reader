// @vitest-environment jsdom

import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { StudyRootController } from '../src/client/StudyRoot.tsx'
import { en, zh } from '../src/client/locales.ts'

vi.mock('../src/client/ReadingWorkspace.tsx', () => ({
  ReadingWorkspace: (props: { readonly sessionId?: string }) => <div data-testid="reading-workspace">{props.sessionId}</div>,
}))

class Snapshot<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

function sessionId(value: string): SessionId {
  return value as SessionId
}

function listFor(id: SessionId | undefined, preset = 'reading', blank = true): SessionListState {
  return {
    current: id,
    byId: id === undefined ? {} : { [id]: { agentPreset: preset, blank } },
  } as unknown as SessionListState
}

function controllerFor(initial: SessionListState) {
  const list = new Snapshot(initial)
  const currentProvideInfo = {
    getSnapshot: () => ({ sessionId: list.getSnapshot().current, hooks: {}, props: {} }),
    subscribe: (listener: () => void) => list.subscribe(listener),
  }
  const sessions = { list, currentProvideInfo } as Pick<ISessions, 'list' | 'currentProvideInfo'>
  const controller = new StudyRootController({
    sessions,
    studyRemote: undefined,
    document,
    locale: testLocale(),
  })
  return { controller, list }
}

function testLocale(language: 'zh' | 'en' = 'zh') {
  const dictionary = language === 'en' ? en : zh
  return {
    listeners: new Set<() => void>(),
    bind() { return (key: string) => dictionary[key as keyof typeof dictionary] ?? key },
    getSnapshot() { return { revision: 1 } },
    subscribe(listener: () => void) {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
}

function openLibrary(): void {
  fireEvent.click(screen.getByRole('button', { name: /^全部文献/u }))
}

afterEach(() => {
  document.body.replaceChildren()
  document.head.querySelectorAll('[data-dsh-study-root-style]').forEach(node => node.remove())
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('StudyRootController', () => {
  it('renders the complete shell from the active Host English locale', () => {
    const list = new Snapshot(listFor(sessionId('reading-en')))
    const currentProvideInfo = { getSnapshot: () => ({ sessionId: list.getSnapshot().current, hooks: {}, props: {} }), subscribe: (listener: () => void) => list.subscribe(listener) }
    const controller = new StudyRootController({ sessions: { list, currentProvideInfo } as unknown as Pick<ISessions, 'list' | 'currentProvideInfo'>, studyRemote: undefined, document, locale: testLocale('en') })
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bookroom' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^All documents/u })).toBeTruthy()
    act(() => { dispose() })
  })

  it('leaves Standard and a blank non-study session without plugin DOM', () => {
    const { controller } = controllerFor(listFor(sessionId('standard'), 'standard'))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    expect(document.body.querySelector('[data-dsh-study-root]')).toBeNull()
    expect(document.head.querySelector('[data-dsh-study-root-style]')).toBeNull()

    act(() => { dispose() })
  })

  it('does not mount the Bookroom for the removed debug preset', () => {
    const { controller } = controllerFor(listFor(sessionId('debug-session'), 'debug'))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    expect(document.body.querySelector('[data-dsh-study-root]')).toBeNull()
    expect(document.head.querySelector('[data-dsh-study-root-style]')).toBeNull()

    act(() => { dispose() })
  })

  it('opens a blank reading session in Bookroom without requesting an Agent prompt', () => {
    const { controller } = controllerFor(listFor(sessionId('reading-blank')))
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    openLibrary()

    expect(screen.getByTestId('reading-workspace').textContent).toBe('reading-blank')
    const separator = screen.getByRole('separator', { name: '调整资产导航宽度' })
    const beforeWidth = Number.parseInt(getComputedStyle(document.querySelector('.dsh-studio')!).getPropertyValue('--dsh-studio-tree-width'), 10)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(document.querySelector('.dsh-studio')?.getAttribute('style')).toContain(`--dsh-studio-tree-width: ${beforeWidth + 16}px`)
    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-surface')).toBe('study')

    act(() => { dispose() })
  })

  it('hides the overlay for Chat while retaining the surface switcher and restores Bookroom', () => {
    const { controller } = controllerFor(listFor(sessionId('reading-chat')))
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    openLibrary()
    const workspace = screen.getByTestId('reading-workspace')

    act(() => { fireEvent.click(screen.getByRole('button', { name: '对话' })) })
    expect(document.body.querySelector('[data-dsh-study-root]')).not.toBeNull()
    expect(document.body.querySelector('.dsh-study-root-overlay')?.hasAttribute('hidden')).toBe(true)
    expect(document.body.contains(screen.getByRole('button', { name: '书房' }))).toBe(true)

    act(() => { fireEvent.click(screen.getByRole('button', { name: '书房' })) })
    expect(screen.getByTestId('reading-workspace').textContent).toBe('reading-chat')
    expect(screen.getByTestId('reading-workspace')).toBe(workspace)

    act(() => { dispose() })
  })

  it('keeps remembered surfaces isolated by SessionId when navigation changes', () => {
    const first = sessionId('session-one')
    const second = sessionId('session-two')
    const { controller, list } = controllerFor(listFor(first))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    act(() => { fireEvent.click(screen.getByRole('button', { name: '对话' })) })
    act(() => { list.publish(listFor(second)) })
    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-surface')).toBe('study')
    openLibrary()
    expect(screen.getByTestId('reading-workspace').textContent).toBe('session-two')

    act(() => { list.publish(listFor(first)) })
    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-surface')).toBe('chat')

    act(() => { dispose() })
  })

  it('follows the Host current-session projection and ignores a late list current value', () => {
    const first = sessionId('host-session-a')
    const second = sessionId('host-session-b')
    const list = new Snapshot({
      current: first,
      byId: {
        [first]: { agentPreset: 'reading', blank: true },
        [second]: { agentPreset: 'reading', blank: true },
      },
    } as unknown as SessionListState)
    const currentProvideInfo = new Snapshot({ sessionId: first, hooks: {}, props: {} })
    const controller = new StudyRootController({
      sessions: { list, currentProvideInfo } as Pick<ISessions, 'list' | 'currentProvideInfo'>,
      studyRemote: undefined,
      document,
      locale: testLocale(),
    })
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    act(() => { currentProvideInfo.publish({ sessionId: second, hooks: {}, props: {} }) })
    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-session-id')).toBe('host-session-b')
    act(() => { list.publish({ ...list.getSnapshot(), current: first }) })
    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-session-id')).toBe('host-session-b')
    act(() => { dispose() })
  })

  it('keeps the Studio section isolated per session and restores it after Chat', () => {
    const first = sessionId('management-one')
    const second = sessionId('management-two')
    const { controller, list } = controllerFor(listFor(first))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    act(() => { fireEvent.click(screen.getByRole('button', { name: /^Skills/u })) })
    expect(screen.getByRole('region', { name: 'Skills 管理' })).toBeTruthy()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '对话' })) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '书房' })) })
    expect(screen.getByRole('region', { name: 'Skills 管理' })).toBeTruthy()

    act(() => { list.publish(listFor(second)) })
    openLibrary()
    expect(screen.getByTestId('reading-workspace').textContent).toBe('management-two')
    act(() => { list.publish(listFor(first)) })
    expect(screen.getByRole('region', { name: 'Skills 管理' })).toBeTruthy()
    act(() => { dispose() })
  })

  it('remounts the workspace for a different SessionId instead of leaking the prior reader subtree', () => {
    const first = sessionId('reader-one')
    const second = sessionId('reader-two')
    const { controller, list } = controllerFor(listFor(first))
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    openLibrary()
    const firstWorkspace = screen.getByTestId('reading-workspace')

    act(() => { list.publish(listFor(second)) })
    openLibrary()
    const secondWorkspace = screen.getByTestId('reading-workspace')
    expect(secondWorkspace).not.toBe(firstWorkspace)
    expect(secondWorkspace.textContent).toBe('reader-two')

    act(() => { list.publish(listFor(first)) })
    openLibrary()
    const restoredFirstWorkspace = screen.getByTestId('reading-workspace')
    expect(restoredFirstWorkspace).not.toBe(secondWorkspace)
    expect(restoredFirstWorkspace.textContent).toBe('reader-one')

    act(() => { dispose() })
  })

  it('removes subscriptions, React resources, and plugin CSS when Standard replaces reading', () => {
    const { controller, list } = controllerFor(listFor(sessionId('reading-exit')))
    let dispose!: () => void
    act(() => { dispose = controller.start() })
    expect(list.listenerCount()).toBe(2)

    act(() => { list.publish(listFor(sessionId('standard'), 'standard')) })
    expect(document.body.querySelector('[data-dsh-study-root]')).toBeNull()
    expect(document.head.querySelector('[data-dsh-study-root-style]')).toBeNull()

    act(() => { dispose() })
    expect(list.listenerCount()).toBe(0)
  })

  it('preserves pre-existing body nodes while disposal removes only plugin resources', () => {
    const host = document.createElement('main')
    host.textContent = 'Host-owned body node'
    document.body.append(host)
    const { controller, list } = controllerFor(listFor(sessionId('reading-dispose')))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    act(() => { dispose() })
    expect(document.body.contains(host)).toBe(true)
    expect(document.body.querySelector('[data-dsh-study-root]')).toBeNull()
    expect(document.head.querySelector('[data-dsh-study-root-style]')).toBeNull()
    expect(list.listenerCount()).toBe(0)
  })

  it('migrates a removed trace surface to Bookroom without exposing a third tab', () => {
    const activeSessionId = sessionId('old-trace-session')
    window.localStorage.setItem('dsh.study-reader.surface.v1', JSON.stringify({ [activeSessionId]: 'trace' }))
    const { controller } = controllerFor(listFor(activeSessionId))
    let dispose!: () => void
    act(() => { dispose = controller.start() })

    expect(document.body.querySelector('[data-dsh-study-root]')?.getAttribute('data-surface')).toBe('study')
    expect(screen.queryByRole('button', { name: '轨迹' })).toBeNull()
    openLibrary()
    expect(screen.getByTestId('reading-workspace').textContent).toBe('old-trace-session')

    act(() => { dispose() })
  })
})
