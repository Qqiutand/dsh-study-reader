import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { StudyReaderLocaleKey } from './locales.ts'

interface ClientErrorBoundaryProps {
  readonly children: ReactNode
  readonly resetKey: string
  readonly t: (key: StudyReaderLocaleKey) => string
}

interface ClientErrorBoundaryState {
  readonly error: Error | null
}

/** Keep one faulty Bookroom panel from taking down the surrounding DSH UI. */
export class ClientErrorBoundary extends Component<ClientErrorBoundaryProps, ClientErrorBoundaryState> {
  override state: ClientErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ClientErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Study Reader UI failed', error, info)
  }

  override componentDidUpdate(previous: ClientErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return <section className="dsh-study-error-boundary" role="alert">
      <h2>{this.props.t('error.title')}</h2>
      <p>{this.props.t('error.body')}</p>
      <details><summary>{this.props.t('error.details')}</summary><pre>{this.state.error.message}</pre></details>
      <button type="button" onClick={() => { this.setState({ error: null }) }}>{this.props.t('action.retry')}</button>
    </section>
  }
}
