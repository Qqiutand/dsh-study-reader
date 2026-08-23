import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { STUDY_READER_LOCALE_NS, type StudyReaderLocaleKey } from './locales.ts'

type Translate = (key: string, params?: Record<string, unknown>) => string

export interface StudyLocaleFace {
  readonly bind: (namespace: string) => Translate
  readonly getSnapshot: () => { readonly revision: number }
  readonly subscribe: (listener: () => void) => () => void
}

type StudyTranslate = (key: StudyReaderLocaleKey, params?: Record<string, unknown>) => string
export type BilingualText = (zh: string, en: string) => string

const fallback: StudyTranslate = key => key
const StudyLocaleContext = createContext<StudyTranslate>(fallback)

export function StudyLocaleProvider(props: { readonly locale: StudyLocaleFace; readonly children: ReactNode }) {
  // Host locale methods are class methods. Passing `subscribe` directly to
  // React loses its receiver after newer Harness builds stopped binding the
  // method at construction time, which crashes the complete Bookroom root.
  const subscribe = useCallback((listener: () => void) => props.locale.subscribe(listener), [props.locale])
  const getRevision = useCallback(() => props.locale.getSnapshot().revision, [props.locale])
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return <StudyLocaleContext.Provider value={props.locale.bind(STUDY_READER_LOCALE_NS) as StudyTranslate}>
    {props.children}
  </StudyLocaleContext.Provider>
}

export function useStudyLocale(): StudyTranslate {
  return useContext(StudyLocaleContext)
}

/** Select user-facing copy from the active DSH Host locale. */
export function useBilingualText(): BilingualText {
  const translate = useStudyLocale()
  const english = translate('locale.code') === 'en'
  return useCallback((zh: string, en: string) => english ? en : zh, [english])
}
