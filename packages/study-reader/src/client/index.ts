/**
 * Study Reader browser plugin. It mounts the generated Remote namespace and
 * plugin-owned browser surface without replacing Harness conversation views.
 * @module dsh-study-reader/client
 */

import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import studyRemote from 'dsh-study-reader/remote'
import { StudyRootController } from './StudyRoot.tsx'
import type { StudyRemote } from './remote.ts'
import { en, STUDY_READER_LOCALE_NS, zh } from './locales.ts'

/** Required services: Remote assembly, sessions, and the credential connection. */
export const inject = ['remote', 'sessions', 'connection', 'locale']

export async function apply(ctx: ClientContext): Promise<void> {
  const locale = (ctx as ClientContext & { readonly locale: import('./StudyLocale.tsx').StudyLocaleFace & { readonly register: (namespace: string, dictionaries: { readonly zh: typeof zh; readonly en: typeof en }) => () => void } }).locale
  ctx.effect(() => locale.register(STUDY_READER_LOCALE_NS, { zh, en }), 'ui-study: dictionaries')
  const disposeRemote = await ctx.remote.$mount(studyRemote)
  ctx.effect(() => disposeRemote, 'ui-study: remote contribution')

  const api = (ctx.get('connection') as {
    readonly api: import('@deepseek-ai/dsh-api-remotes/client').IApiClient
  }).api
  const studyRoot = new StudyRootController({
    sessions: ctx.get('sessions') as unknown as Pick<ISessions, 'list' | 'currentProvideInfo'>,
    studyRemote: ctx.get('remote.study' as never) as StudyRemote | undefined,
    credentialsApi: api.credentials,
    locale,
  })
  ctx.effect(() => studyRoot.start(), 'ui-study: preset-scoped body root')

}
