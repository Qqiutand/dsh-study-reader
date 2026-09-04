/** Stateless document library with a chapter index and bounded semantic preview. */
import { createElement, useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { ImportStatusView, PreviewSection, SourcePreview, SourceSummary, StudyBlock } from '../study/types.ts'
import type { StudioAssetSummary } from '../studio/types.ts'
import { beginFileUpload } from './logic.ts'
import type { StudyRemote } from './remote.ts'
import { READING_WORKSPACE_CSS, readingWorkspaceClass as css } from './ReadingWorkspace.css.ts'
import { OriginalDocumentFrame } from './OriginalDocumentFrame.tsx'
import { VerticalResizeHandle } from './VerticalResizeHandle.tsx'
import { useBilingualText, type BilingualText } from './StudyLocale.tsx'

export interface ReadingWorkspaceProps {
  readonly studyRemote: StudyRemote | undefined
  readonly sessionId?: string
  readonly folderId?: string
  readonly refreshVersion?: number
}

const DEFAULT_ASSET_ROUTE = '/study-reader/assets'
const DEFAULT_ACCEPT = '.pdf,application/pdf,.epub,application/epub+zip,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.bmp,.tiff,.webp'
const LIBRARY_WIDTH_STORAGE_KEY = 'dsh-study-reader:library-width'
const OUTLINE_WIDTH_STORAGE_KEY = 'dsh-study-reader:outline-width'

function storedWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  if (typeof window === 'undefined') return fallback
  const saved = Number(window.localStorage.getItem(key))
  return Number.isFinite(saved) ? Math.min(maximum, Math.max(minimum, saved)) : fallback
}

function commandId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function ReadingWorkspace({ studyRemote, sessionId, folderId, refreshVersion = 0 }: ReadingWorkspaceProps) {
  const b = useBilingualText()
  const [sources, setSources] = useState<readonly SourceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [assetRoute, setAssetRoute] = useState(DEFAULT_ASSET_ROUTE)
  const [language, setLanguage] = useState('ch')
  const [folders, setFolders] = useState<readonly { readonly id: string; readonly name: string }[]>([])
  const [targetFolderId, setTargetFolderId] = useState('')
  const [isOcr, setIsOcr] = useState(true)
  const [enableTable, setEnableTable] = useState(true)
  const [enableFormula, setEnableFormula] = useState(true)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [submittedLibraryQuery, setSubmittedLibraryQuery] = useState('')
  const [libraryAssets, setLibraryAssets] = useState<readonly StudioAssetSummary[]>([])
  const [libraryCursor, setLibraryCursor] = useState<string>()
  const [moveAsset, setMoveAsset] = useState<StudioAssetSummary>()
  const [moveFolderId, setMoveFolderId] = useState('')
  const [editSource, setEditSource] = useState<SourceSummary>()
  const [editTitle, setEditTitle] = useState('')
  const [menuSourceId, setMenuSourceId] = useState<string>()
  const [deleteSource, setDeleteSource] = useState<SourceSummary>()
  const [deleteTitle, setDeleteTitle] = useState('')
  const [preview, setPreview] = useState<readonly StudyBlock[]>([])
  const [previewView, setPreviewView] = useState<SourcePreview>()
  const [sections, setSections] = useState<readonly PreviewSection[]>([])
  const [activeSectionIndex, setActiveSectionIndex] = useState(0)
  const [imports, setImports] = useState<readonly ImportStatusView[]>([])
  const [importPollGeneration, setImportPollGeneration] = useState(0)
  const [importPollingEnabled, setImportPollingEnabled] = useState(false)
  const [uploadBatchProgress, setUploadBatchProgress] = useState<{ readonly current: number; readonly total: number; readonly fileName: string }>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [pdfPreviewMode, setPdfPreviewMode] = useState<'semantic' | 'original'>('original')
  const [readerPage, setReaderPage] = useState(1)
  const [readerZoom, setReaderZoom] = useState(100)
  const [libraryWidth, setLibraryWidth] = useState(() => storedWidth(LIBRARY_WIDTH_STORAGE_KEY, 320, 250, 480))
  const [outlineWidth, setOutlineWidth] = useState(() => storedWidth(OUTLINE_WIDTH_STORAGE_KEY, 300, 220, 460))
  const [libraryOpen, setLibraryOpen] = useState(true)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const uploadRef = useRef<AbortController>()
  const previewGenerationRef = useRef(0)

  useEffect(() => {
    if (menuSourceId === undefined) return
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || event.target.closest('[data-source-menu]') === null) setMenuSourceId(undefined)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuSourceId])

  useEffect(() => () => uploadRef.current?.abort(), [])

  const selected = sources.find(source => String(source.id) === selectedId)
  const normalizedAssetRoute = `/${assetRoute.split('/').filter(Boolean).join('/')}`
  const pdfjsWasmUrl = `${normalizedAssetRoute}/_pdfjs/wasm/`
  const pdfjsWorkerUrl = `${normalizedAssetRoute}/_pdfjs/worker/pdf.worker.mjs`
  const loadSources = useCallback(async (): Promise<readonly SourceSummary[]> => {
    if (studyRemote === undefined || sessionId === undefined) return []
    const result = await studyRemote.listSources({ scope: 'library', sessionId })
    if (!result.ok) throw new Error(result.error.message)
    setSources(result.value)
    return result.value
  }, [sessionId, studyRemote])

  const loadLibraryAssets = useCallback(async (cursor?: string): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined) return
    const result = await studyRemote.listAssets({ sessionId, namespace: 'library', ...(folderId === undefined ? {} : { folderId }), ...(submittedLibraryQuery === '' ? {} : { query: submittedLibraryQuery }), ...(cursor === undefined ? {} : { cursor }), limit: 40 })
    if (!result.ok) throw new Error(result.error.message)
    setLibraryAssets(current => cursor === undefined ? result.value.assets : [...current, ...result.value.assets])
    setLibraryCursor(result.value.nextCursor)
  }, [folderId, sessionId, studyRemote, submittedLibraryQuery])

  useEffect(() => {
    setLibraryAssets([])
    setLibraryCursor(undefined)
    void loadLibraryAssets().catch(error => setNotice(error instanceof Error ? error.message : b('加载文献列表失败', 'Failed to load documents')))
  }, [b, loadLibraryAssets])

  useEffect(() => {
    if (studyRemote === undefined || sessionId === undefined) return
    let cancelled = false
    void studyRemote.getLibrarySnapshot({ sessionId })
      .then(snapshot => {
        if (cancelled) return
        if (!snapshot.ok) throw new Error(snapshot.error.message)
        setAssetRoute(snapshot.value.assetRoute)
        setLanguage(snapshot.value.defaultLanguage)
        setFolders(snapshot.value.folders ?? [])
        setImports(snapshot.value.activeImports ?? [])
        setImportPollingEnabled((snapshot.value.activeImports?.length ?? 0) > 0)
        setSources(snapshot.value.selectedSource === undefined || snapshot.value.sources.some(source => source.id === snapshot.value.selectedSource?.id)
          ? snapshot.value.sources
          : [snapshot.value.selectedSource, ...snapshot.value.sources])
      })
      .catch(error => { if (!cancelled) setNotice(error instanceof Error ? error.message : b('加载文献库失败', 'Failed to load the library')) })
    return () => { cancelled = true }
  }, [b, refreshVersion, sessionId, studyRemote])

  useEffect(() => {
    if (studyRemote === undefined || sessionId === undefined || !importPollingEnabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previouslyActive = false
    const poll = async (): Promise<void> => {
      const result = await studyRemote.listImportStatuses({ limit: 100 })
      if (cancelled || !result.ok) return
      setImports(result.value)
      const active = result.value.some(item => !['ready', 'failed', 'cancelled'].includes(item.state))
      if (previouslyActive && !active) {
        const snapshot = await studyRemote.getLibrarySnapshot({ sessionId })
        if (!cancelled && snapshot.ok) {
          setSources(snapshot.value.selectedSource === undefined || snapshot.value.sources.some(source => source.id === snapshot.value.selectedSource?.id)
            ? snapshot.value.sources
            : [snapshot.value.selectedSource, ...snapshot.value.sources])
          setNotice(snapshot.value.selection.sourceId === undefined ? b('文献已导入。', 'Document imported.') : b('文献已导入并打开。', 'Document imported and opened.'))
          await loadLibraryAssets()
        }
      }
      previouslyActive = active
      if (active) timer = setTimeout(() => { void poll() }, 1_200)
      else setImportPollingEnabled(false)
    }
    void poll()
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
  }, [b, importPollGeneration, importPollingEnabled, loadLibraryAssets, sessionId, studyRemote])

  useEffect(() => {
    const generation = previewGenerationRef.current + 1
    previewGenerationRef.current = generation
    setPreviewView(undefined)
    setPreview([])
    setSections([])
    setActiveSectionIndex(0)
    setReaderPage(1)
    if (studyRemote === undefined || sessionId === undefined || selected?.revisionId === undefined) return
    const directOriginalUrl = `${normalizedAssetRoute}/${encodeURIComponent(String(selected.id))}/${encodeURIComponent(String(selected.revisionId))}/original`
    if (selected.format === 'pdf') {
      setPreviewView({
        kind: 'pdf', title: selected.title, originalUrl: directOriginalUrl,
        ...(selected.pageCount === undefined ? {} : { pageCount: selected.pageCount }),
        sections: [], blocks: [], truncated: false,
        semanticAvailable: (selected.blockCount ?? 0) > 0,
      })
      setPdfPreviewMode('original')
    } else if (selected.format === 'epub') {
      setPreviewView({ kind: 'epub', title: selected.title, originalUrl: directOriginalUrl, sections: [], blocks: [], truncated: false })
    }
    let cancelled = false
    setBusy(true)
    void studyRemote.getSourcePreview({ sessionId, sourceId: selected.id, revisionId: selected.revisionId })
      .then(result => {
        if (cancelled || previewGenerationRef.current !== generation) return
        if (!result.ok) throw new Error(result.error.message)
        setPreviewView(result.value)
        setPreview(result.value.blocks)
        setSections(result.value.sections)
        setPdfPreviewMode('original')
      })
      .catch(error => { if (!cancelled && previewGenerationRef.current === generation) setNotice(error instanceof Error ? error.message : b('预览加载失败', 'Preview loading failed')) })
      .finally(() => { if (!cancelled && previewGenerationRef.current === generation) setBusy(false) })
    return () => { cancelled = true }
  }, [assetRoute, b, selected?.blockCount, selected?.format, selected?.id, selected?.pageCount, selected?.revisionId, selected?.title, sessionId, studyRemote])

  const showSection = async (index: number): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || selected?.revisionId === undefined || sections[index] === undefined) return
    setBusy(true)
    try {
      const result = await studyRemote.getSourcePreview({ sessionId, sourceId: selected.id, revisionId: selected.revisionId, sectionId: sections[index].id })
      if (!result.ok) throw new Error(result.error.message)
      setPreviewView(result.value)
      setPreview(result.value.blocks)
      setActiveSectionIndex(index)
    } catch (error) { setNotice(error instanceof Error ? error.message : b('章节加载失败', 'Section loading failed')) }
    finally { setBusy(false) }
  }

  const previewSource = (source: SourceSummary): void => {
    if (source.revisionId === undefined) return
    setNotice(undefined)
    setSources(current => current.some(item => String(item.id) === String(source.id)) ? current : [source, ...current])
    setSelectedId(String(source.id))
  }

  const setAccess = async (source: SourceSummary, granted: boolean): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await studyRemote.setSourceAccess({ sessionId, sourceId: source.id, granted })
      if (!result.ok) throw new Error(result.error.message)
      await Promise.all([loadSources(), loadLibraryAssets()])
    } catch (error) { setNotice(error instanceof Error ? error.message : b('更新对话资料失败', 'Failed to update conversation documents')) }
    finally { setBusy(false) }
  }

  const permanentlyDeleteSource = async (): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || deleteSource === undefined || deleteTitle !== deleteSource.title) return
    setBusy(true); setNotice(undefined)
    try {
      const proposed = await studyRemote.executeManagementCommand({
        sessionId, commandId: commandId('delete-source-proposal'),
        command: { kind: 'create-proposal', proposalKind: 'delete-source', targetId: deleteSource.id, title: deleteSource.title, targetVersion: deleteSource.recordVersion },
      })
      if (!proposed.ok) throw new Error(proposed.error.message)
      if (proposed.value.proposal === undefined) throw new Error(b('删除请求没有返回确认记录。', 'The deletion request returned no confirmation record.'))
      const decided = await studyRemote.decideManagementProposal({
        sessionId, commandId: commandId('delete-source-confirm'), proposalId: proposed.value.proposal.id,
        expectedVersion: proposed.value.proposal.version, decision: 'approved', expectedTitle: deleteSource.title,
      })
      if (!decided.ok) throw new Error(decided.error.message)
      if (selectedId === String(deleteSource.id)) {
        setSelectedId(undefined); setPreview([]); setPreviewView(undefined); setSections([])
      }
      setDeleteSource(undefined); setDeleteTitle('')
      await Promise.all([loadSources(), loadLibraryAssets()])
      setNotice(b(`已永久删除《${deleteSource.title}》。`, `Permanently deleted “${deleteSource.title}”.`))
    } catch (error) { setNotice(error instanceof Error ? error.message : b('删除文献失败', 'Failed to delete document')) }
    finally { setBusy(false) }
  }

  const saveSourceTitle = async (): Promise<void> => {
    if (studyRemote === undefined || sessionId === undefined || editSource === undefined || editTitle.trim() === '') return
    setBusy(true); setNotice(undefined)
    try {
      const result = await studyRemote.renameSource({
        sessionId, commandId: commandId('rename-source'), sourceId: editSource.id,
        title: editTitle.trim(), expectedVersion: editSource.recordVersion,
      })
      if (!result.ok) throw new Error(result.error.message)
      setEditSource(undefined); setEditTitle('')
      await Promise.all([loadSources(), loadLibraryAssets()])
      setNotice(b('文献标题已更新。', 'Document title updated.'))
    } catch (error) { setNotice(error instanceof Error ? error.message : b('修改文献标题失败', 'Failed to update document title')) }
    finally { setBusy(false) }
  }

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length === 0 || studyRemote === undefined || sessionId === undefined) return
    setImportDialogOpen(false)
    uploadRef.current?.abort()
    const controller = new AbortController()
    uploadRef.current = controller
    const options = { sessionId, ...(targetFolderId === '' ? {} : { targetFolderId }), language, isOcr, enableTable, enableFormula }
    setNotice(undefined)
    setBusy(true)
    void (async () => {
      let admittedCount = 0
      const failures: string[] = []
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) return
        setUploadBatchProgress({ current: index + 1, total: files.length, fileName: file.name })
        try {
          const status = await beginFileUpload(studyRemote, file, controller.signal, options)
          admittedCount += 1
          setImports(current => [status, ...current.filter(item => item.importId !== status.importId)])
          if (admittedCount === 1) {
            setImportPollGeneration(current => current + 1)
            setImportPollingEnabled(true)
          }
          if (status.state === 'failed' || status.state === 'cancelled') failures.push(`${file.name}: ${status.failure?.message ?? b('导入失败', 'Import failed')}`)
        } catch (error) {
          if (controller.signal.aborted) return
          failures.push(`${file.name}: ${error instanceof Error ? error.message : b('导入失败', 'Import failed')}`)
        }
      }
      if (controller.signal.aborted) return
      if (admittedCount > 0) {
        await Promise.all([loadSources(), loadLibraryAssets()])
        if (controller.signal.aborted) return
      }
      const succeeded = files.length - failures.length
      const failureDetails = failures.slice(0, 3).join(b('；', '; '))
      const omittedFailures = Math.max(0, failures.length - 3)
      const failureSuffix = omittedFailures === 0 ? '' : b(`；另有 ${String(omittedFailures)} 篇失败`, `; ${String(omittedFailures)} more failed`)
      if (failures.length === 0) setNotice(b(`已提交 ${String(succeeded)} 篇文献，后台正在处理。`, `${String(succeeded)} documents submitted for background processing.`))
      else if (succeeded === 0) setNotice(b(`这批 ${String(files.length)} 篇文献均未能导入：${failureDetails}${failureSuffix}`, `None of the ${String(files.length)} documents could be imported: ${failureDetails}${failureSuffix}`))
      else setNotice(b(`已提交 ${String(succeeded)} 篇文献，${String(failures.length)} 篇失败：${failureDetails}${failureSuffix}`, `${String(succeeded)} documents submitted; ${String(failures.length)} failed: ${failureDetails}${failureSuffix}`))
    })()
      .catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : b('导入失败', 'Import failed')) })
      .finally(() => {
        if (uploadRef.current !== controller) return
        uploadRef.current = undefined
        setUploadBatchProgress(undefined)
        setBusy(false)
      })
  }

  const originalUrl = previewView === undefined || !('originalUrl' in previewView) ? undefined : previewView.originalUrl
  const activeImports = imports.filter(item => !['ready', 'failed', 'cancelled'].includes(item.state))
  const failedImports = imports.filter(item => item.state === 'failed')
  const visibleSources = libraryAssets.flatMap(asset => asset.source === undefined ? [] : [{ asset, source: asset.source }])
  const aiVisibleSources = visibleSources.filter(({ source }) => source.granted !== false)
  const aiVisibleCount = visibleSources.filter(({ source }) => source.granted !== false).length
  const aiHiddenCount = visibleSources.length - aiVisibleCount

  useEffect(() => {
    if (folderId === undefined) {
      return
    }
    if (visibleSources.some(({ source }) => String(source.id) === selectedId)) return
    setSelectedId(undefined)
    // Never leave a document from another folder underneath the folder view.
    setPreviewView(undefined)
    setPreview([])
    setSections([])
  }, [folderId, libraryAssets, selectedId])
  const navigateSection = (index: number): void => {
    const section = sections[index]
    if (section === undefined) return
    setActiveSectionIndex(index)
    setReaderPage(selected?.format === 'epub' ? index + 1 : Math.max(1, section.page ?? 1))
    if (pdfPreviewMode === 'semantic') void showSection(index)
  }
  const observeReaderPage = useCallback((page: number): void => {
    setReaderPage(page)
    if (selected?.format === 'epub') setActiveSectionIndex(Math.max(0, Math.min(sections.length - 1, page - 1)))
    else {
      const index = sections.findLastIndex(section => (section.page ?? 1) <= page)
      if (index >= 0) setActiveSectionIndex(index)
    }
  }, [sections, selected?.format])

  const resizeLibrary = (delta: number): void => setLibraryWidth(current => {
    const next = Math.min(480, Math.max(250, current + delta))
    window.localStorage.setItem(LIBRARY_WIDTH_STORAGE_KEY, String(next))
    return next
  })
  const resizeOutline = (delta: number): void => setOutlineWidth(current => {
    const next = Math.min(460, Math.max(220, current - delta))
    window.localStorage.setItem(OUTLINE_WIDTH_STORAGE_KEY, String(next))
    return next
  })
  const workspaceStyle = {
    '--dsh-library-list-width': `${libraryWidth}px`,
    '--dsh-library-outline-width': `${outlineWidth}px`,
  } as CSSProperties

  return <main className={css.root} style={workspaceStyle}>
    <style data-plugin-css="ui-study/reading-workspace">{READING_WORKSPACE_CSS}</style>
    <header className={css.header}>
      <div><strong>{b('书房', 'Bookroom')}</strong>{selected === undefined ? <span>{b('选择一本文献开始阅读', 'Select a document to begin')}</span> : <span>{selected.title}</span>}</div>
      <nav aria-label={b('书房操作', 'Bookroom actions')}><button type="button" aria-expanded={libraryOpen} aria-controls="study-library-panel" onClick={() => setLibraryOpen(value => !value)}>{libraryOpen ? b('收起书库', 'Hide library') : b('展开书库', 'Show library')}</button>{selected === undefined ? null : <button type="button" aria-pressed={outlineOpen} onClick={() => setOutlineOpen(value => !value)}>{b('目录', 'Outline')}</button>}{selected === undefined ? null : <button type="button" data-conversation-available={selected.granted === false ? 'false' : 'true'} disabled={busy} onClick={() => { void setAccess(selected, selected.granted === false) }}>{selected.granted === false ? b('加入本次对话', 'Add to conversation') : b('移出本次对话', 'Remove from conversation')}</button>}{originalUrl === undefined ? null : <><a href={originalUrl} target="_blank" rel="noreferrer">{b('打开原文件', 'Open original')}</a><a href={originalUrl} download={selected?.originalFileName ?? selected?.title}>{b('下载原文件', 'Download original')}</a></>}{previewView?.kind === 'pdf' && previewView.semanticExportUrl !== undefined ? <a href={previewView.semanticExportUrl} download>{b('导出识别结果', 'Export extracted data')}</a> : null}<button type="button" className={css.importButton} disabled={uploadBatchProgress !== undefined} onClick={() => setImportDialogOpen(true)}>{uploadBatchProgress === undefined ? b('导入文献', 'Import document') : b('正在提交…', 'Submitting…')}</button></nav>
    </header>
    {importDialogOpen ? <div className={css.dialogBackdrop} role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="study-import-title" className={css.importDialog}>
      <header><h2 id="study-import-title">{b('导入文献', 'Import document')}</h2><button type="button" aria-label={b('关闭导入文献', 'Close import dialog')} onClick={() => setImportDialogOpen(false)}>×</button></header>
      <label>{b('识别语言', 'Recognition language')} <select aria-label={b('PDF / MinerU 识别语言', 'PDF / MinerU recognition language')} value={language} onChange={event => setLanguage(event.target.value)}>
        <option value="ch">{b('中英文', 'Chinese & English')}</option><option value="en">English</option><option value="korean">한국어</option><option value="japan">日本語</option>
        <option value="french">Français</option><option value="german">Deutsch</option><option value="spanish">Español</option><option value="russian">Русский</option>
      </select></label>
      <label>{b('目标文件夹', 'Destination folder')} <select aria-label={b('导入目标文件夹', 'Import destination folder')} value={targetFolderId} onChange={event => setTargetFolderId(event.target.value)}><option value="">{b('未分类', 'Uncategorized')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
      <label><input type="checkbox" checked={isOcr} onChange={event => setIsOcr(event.target.checked)} /> OCR</label>
      <label><input type="checkbox" checked={enableTable} onChange={event => setEnableTable(event.target.checked)} /> {b('表格识别', 'Table recognition')}</label>
      <label><input type="checkbox" checked={enableFormula} onChange={event => setEnableFormula(event.target.checked)} /> {b('公式识别', 'Formula recognition')}</label>
      <p>{b('识别语言仅用于 PDF；EPUB 使用本地文本解析。可在文件选择器中用 Ctrl、Command 或 Shift 一次选择多本，所选文件都会进入同一个目标文件夹。', 'Recognition language applies to PDF only; EPUB is parsed locally. Use Ctrl, Command, or Shift in the file picker to select multiple documents; all selected files go to the same destination folder.')}</p>
      <label className={css.importButton}>{b('选择文件（可多选）', 'Choose files')}<input aria-label={b('选择要导入的文献（可多选）', 'Choose documents to import')} type="file" accept={DEFAULT_ACCEPT} multiple onChange={upload} /></label>
    </section></div> : null}
    {uploadBatchProgress === undefined ? null : <p role="status" aria-live="polite" className={css.notice}>{b(`正在提交 ${String(uploadBatchProgress.current)}/${String(uploadBatchProgress.total)}：${uploadBatchProgress.fileName}`, `Submitting ${String(uploadBatchProgress.current)}/${String(uploadBatchProgress.total)}: ${uploadBatchProgress.fileName}`)}</p>}
    {notice === undefined ? null : <p role="status" className={css.notice}>{notice}</p>}
    {activeImports.length === 0 && failedImports.length === 0 ? null : <section aria-label={b('导入状态', 'Import status')} className={css.importStatus}>
      {activeImports.map(item => <p key={String(item.importId)}><span className={css.statusDot} data-state="active" /><strong>{item.displayName}</strong> · {b('处理中', 'Processing')}{item.progress?.totalPages === undefined ? '' : ` · ${item.progress.completedPages ?? 0}/${item.progress.totalPages} ${b('页', 'pages')}`}</p>)}
      {failedImports.map(item => <p key={String(item.importId)} role="alert"><span className={css.statusDot} data-state="failed" /><strong>{item.displayName}</strong> · {item.failure?.message ?? b('导入失败', 'Import failed')}</p>)}
    </section>}
    <div className={css.layout} data-library-open={libraryOpen}>
      <aside id="study-library-panel" className={css.library} aria-label={b('文献列表', 'Document list')}>
        <form className={css.librarySearch} onSubmit={event => { event.preventDefault(); setSubmittedLibraryQuery(libraryQuery.trim()) }}><label>{b('搜索书库', 'Search library')}<input value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} placeholder={b('标题或作者', 'Title or author')} /></label><button type="submit">{b('搜索', 'Search')}</button>{submittedLibraryQuery === '' ? null : <button type="button" onClick={() => { setLibraryQuery(''); setSubmittedLibraryQuery('') }}>{b('清除', 'Clear')}</button>}</form>
        <section className={css.aiShelf} aria-label={b('本次对话的文献', 'Conversation documents')}><header><strong>{b('本次对话的文献', 'Conversation documents')}</strong><small>{aiVisibleCount}</small></header>
          <div className={css.aiSourceList}>{aiVisibleSources.length === 0 ? <p>{b('还没有加入本次对话的文献。', 'No documents have been added to this conversation.')}</p> : aiVisibleSources.map(({ source }) => <div key={String(source.id)}><button type="button" className={css.aiSourceOpen} disabled={busy || source.revisionId === undefined} title={b(`预览《${source.title}》`, `Preview “${source.title}”`)} aria-label={b(`预览《${source.title}》`, `Preview “${source.title}”`)} aria-pressed={selectedId === String(source.id)} onClick={() => previewSource(source)}>{source.title}</button><button type="button" className={css.aiSourceRemove} disabled={busy} onClick={() => { void setAccess(source, false) }}>{b('移出', 'Remove')}</button></div>)}</div>
        </section>
        <section className={css.visibleDocuments} aria-label={b('全部文献', 'All documents')}><header><strong>{b('全部文献', 'All documents')}</strong><span><small data-ai-visible="true">{b('对话可用', 'Available')} {aiVisibleCount}</small><small data-ai-visible="false">{b('暂未使用', 'Not in conversation')} {aiHiddenCount}</small><small>{visibleSources.length}</small></span></header>
        <div className={css.sourceList}>
        {libraryAssets.length === 0 ? <p className={css.empty}>{submittedLibraryQuery === '' ? b('文献库为空。', 'The library is empty.') : b('没有匹配的文献。', 'No matching documents.')}</p> : visibleSources.map(({ asset, source }) => <div key={String(source.id)} className={css.sourceRow}>
          <button type="button" disabled={busy || source.revisionId === undefined} title={b('打开文献预览', 'Open document preview')} onContextMenu={event => { event.preventDefault(); setMoveAsset(asset); setMoveFolderId(asset.folderId ?? '') }}
            aria-pressed={selectedId === String(source.id)} onClick={() => previewSource(source)}>
            <strong>{source.title}</strong>{source.authors?.length ? <small>{source.authors.join(' · ')}</small> : null}<small>{source.format?.toUpperCase() ?? 'DOCUMENT'}{source.format === 'epub' && source.sectionCount !== undefined ? ` · ${source.sectionCount} ${b('章', 'sections')}` : source.pageCount === undefined ? '' : ` · ${source.pageCount} ${b('页', 'pages')}`}</small>
            <span className={css.aiVisibility} data-ai-visible={source.granted === false ? 'false' : 'true'}>{source.granted === false ? b('● 暂未使用', '● Not in conversation') : b('● 对话可用', '● Available')}</span>
            <span className={css.openLabel}>{b('打开文献', 'Open document')}</span>
          </button>
          <button type="button" className={css.accessToggle} data-granted={source.granted === false ? 'false' : 'true'} disabled={busy} onClick={() => { void setAccess(source, source.granted === false) }}>{source.granted === false ? b('加入本次对话', 'Add to conversation') : b('移出本次对话', 'Remove from conversation')}</button>
          <div className={css.sourceMenu} data-source-menu><button type="button" className={css.sourceMenuTrigger} aria-label={`${source.title} ${b('更多操作', 'more actions')}`} aria-expanded={menuSourceId === String(source.id)} onClick={() => setMenuSourceId(current => current === String(source.id) ? undefined : String(source.id))}>•••</button>{menuSourceId !== String(source.id) ? null : <div className={css.sourceMenuPopup} role="menu"><button role="menuitem" type="button" onClick={() => { setMenuSourceId(undefined); setEditSource(source); setEditTitle(source.title) }}>{b('编辑标题…', 'Edit title…')}</button><button role="menuitem" type="button" onClick={() => { setMenuSourceId(undefined); setMoveAsset(asset); setMoveFolderId(asset.folderId ?? '') }}>{b('移动到…', 'Move to…')}</button>{selectedId === String(source.id) && originalUrl !== undefined ? <a role="menuitem" href={originalUrl} download={source.originalFileName ?? source.title} onClick={() => setMenuSourceId(undefined)}>{b('下载原文件', 'Download original')}</a> : null}{source.granted === false ? null : <button role="menuitem" type="button" disabled={busy} onClick={() => { setMenuSourceId(undefined); void setAccess(source, false) }}>{b('移出本次对话', 'Remove from conversation')}</button>}<button role="menuitem" type="button" disabled={busy} onClick={() => { setMenuSourceId(undefined); setDeleteSource(source); setDeleteTitle('') }}>{b('删除文献…', 'Delete document…')}</button></div>}</div>
        </div>)}
        {libraryCursor === undefined ? null : <button type="button" disabled={busy} onClick={() => { void loadLibraryAssets(libraryCursor).catch(error => setNotice(error instanceof Error ? error.message : b('加载更多文献失败', 'Failed to load more documents'))) }}>{b('加载更多', 'Load more')}</button>}
        </div></section>
      </aside>
      {libraryOpen ? <VerticalResizeHandle ariaLabel={b('调整文献列表宽度', 'Resize document list')} className={css.paneResizer} onDelta={resizeLibrary} /> : null}
      <section className={css.document}>
        {selected === undefined ? <div className={css.emptyState}><h2>{b('选择一本文献', 'Select a document')}</h2><p>{visibleSources.length === 0 && folderId !== undefined ? b('这个文件夹还是空的。', 'This folder is empty.') : b('从左侧选择文献即可预览；只有明确“加入本次对话”的文献才会提供给助手。', 'Select a document on the left to preview it. Only documents explicitly added to the conversation are available to the assistant.')}</p></div> : <>
          <div className={css.contentGrid} data-outline-open={outlineOpen}>
            <div className={css.preview}>
              <header className={css.readerToolbar}><div><strong>{selected.title}</strong><small>{selected.format?.toUpperCase()}</small></div>{selected.format==='pdf'?<div className={css.modeToggle}><button aria-pressed={pdfPreviewMode==='semantic'} onClick={()=>{setPdfPreviewMode('semantic');void showSection(activeSectionIndex)}}>{b('MinerU 结构层', 'MinerU structure')}</button><button aria-pressed={pdfPreviewMode==='original'} disabled={originalUrl===undefined} onClick={()=>setPdfPreviewMode('original')}>{b('原版 PDF', 'Original PDF')}</button></div>:null}<div className={css.readerControls}><button aria-label={b('上一页', 'Previous page')} disabled={readerPage<=1} onClick={()=>observeReaderPage(readerPage-1)}>◀</button><span>{selected.format==='epub'?b('章节', 'Section'):b('第', 'Page')} <strong>{readerPage}</strong> / {selected.format==='epub'?Math.max(1,sections.length):Math.max(1,selected.pageCount??1)}</span><button aria-label={b('下一页', 'Next page')} disabled={readerPage>=(selected.format==='epub'?sections.length:(selected.pageCount??1))} onClick={()=>observeReaderPage(readerPage+1)}>▶</button><button aria-label={b('缩小', 'Zoom out')} onClick={()=>setReaderZoom(value=>Math.max(60,value-10))}>−</button><span>{readerZoom}%</span><button aria-label={b('放大', 'Zoom in')} onClick={()=>setReaderZoom(value=>Math.min(180,value+10))}>＋</button></div></header>
              <div className="dsh-reader-resizable">
                {selected.format==='epub'&&originalUrl!==undefined?<OriginalDocumentFrame format="epub" url={originalUrl} page={readerPage} onPage={observeReaderPage} pageCount={Math.max(1,sections.length)} sections={sections} zoom={readerZoom} height="100%"/>:selected.format==='pdf'&&pdfPreviewMode==='original'&&originalUrl!==undefined?<OriginalDocumentFrame format="pdf" url={originalUrl} pdfjsWasmUrl={pdfjsWasmUrl} pdfjsWorkerUrl={pdfjsWorkerUrl} page={readerPage} onPage={observeReaderPage} pageCount={selected.pageCount??1} sections={sections} zoom={readerZoom} height="100%"/>:<div className={`${css.textPreview} ${selected.format==='pdf'?css.semanticPreview:''}`} style={{height:'100%'}}><div className={css.chapterHeader}><h3>{sections[activeSectionIndex]?.title??b('结构化内容', 'Structured content')}</h3>{sections.length===0?null:<span>{activeSectionIndex+1} / {sections.length}</span>}</div><BlockList blocks={preview} empty={busy?b('正在加载…', 'Loading…'):b('暂无可预览文本。', 'No preview text available.')} assetUrl={block=>assetUrl(assetRoute,selected,block)} b={b}/>{previewView?.truncated?<p className={css.notice}>{b('当前章节预览已截断。', 'This section preview was truncated.')}</p>:null}</div>}
              </div>
            </div>
            {outlineOpen ? <VerticalResizeHandle ariaLabel={b('调整章节目录宽度', 'Resize outline')} className={css.paneResizer} onDelta={resizeOutline} /> : null}
            {outlineOpen ? <aside className={css.outline} aria-label={b('章节目录', 'Document outline')}><h3>{selected.format === 'epub' ? b('书籍目录', 'Book outline') : b('文献目录', 'Document outline')}</h3>{sections.length === 0 ? <p className={css.empty}>{b('当前文献没有可用目录。', 'No outline is available for this document.')}</p> : <nav>{sections.map((section,index)=><button key={section.id} type="button" aria-current={index===activeSectionIndex?'location':undefined} onClick={()=>navigateSection(index)} disabled={busy}><span>{section.title}</span><small>{selected.format==='epub'?`${index+1} ${b('章', 'section')}`:section.page===undefined?'':`P.${section.page}`}</small></button>)}</nav>}</aside> : null}
          </div>
        </>}
      </section>
    </div>
    {moveAsset === undefined ? null : <div className={css.dialogBackdrop} role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="study-move-source-title" className={css.importDialog}>
      <header><h2 id="study-move-source-title">{b(`移动“${moveAsset.name}”`, `Move “${moveAsset.name}”`)}</h2><button type="button" aria-label={b('关闭移动文献', 'Close move dialog')} onClick={() => setMoveAsset(undefined)}>×</button></header>
      <label>{b('目标文件夹', 'Destination folder')} <select autoFocus value={moveFolderId} onChange={event => setMoveFolderId(event.currentTarget.value)}><option value="">{b('未分类', 'Uncategorized')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
      <div><button type="button" onClick={() => setMoveAsset(undefined)}>{b('取消', 'Cancel')}</button><button type="button" disabled={busy || moveFolderId === (moveAsset.folderId ?? '')} onClick={() => {
        if (studyRemote === undefined || sessionId === undefined) return
        setBusy(true)
        void studyRemote.moveSource({ sessionId, commandId: commandId('move-source'), sourceId: moveAsset.id, expectedVersion: moveAsset.recordVersion, ...(moveFolderId === '' ? {} : { folderId: moveFolderId }) })
          .then(result => { if (!result.ok) throw new Error(result.error.message); setMoveAsset(undefined); return loadLibraryAssets() })
          .catch(error => setNotice(error instanceof Error ? error.message : b('移动文献失败', 'Failed to move document')))
          .finally(() => setBusy(false))
      }}>{b('移动', 'Move')}</button></div>
    </section></div>}
    {editSource === undefined ? null : <div className={css.dialogBackdrop} role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="study-edit-source-title" className={css.importDialog}>
      <header><h2 id="study-edit-source-title">{b('编辑文献标题', 'Edit document title')}</h2><button type="button" aria-label={b('关闭编辑文献', 'Close edit dialog')} onClick={() => { setEditSource(undefined); setEditTitle('') }}>×</button></header>
      <label>{b('显示标题', 'Display title')} <input autoFocus maxLength={500} value={editTitle} onChange={event => setEditTitle(event.currentTarget.value)} /></label>
      <p>{b(`原始文件名：${editSource.originalFileName ?? '未知'}`, `Original filename: ${editSource.originalFileName ?? 'Unknown'}`)}</p>
      <div><button type="button" onClick={() => { setEditSource(undefined); setEditTitle('') }}>{b('取消', 'Cancel')}</button><button type="button" disabled={busy || editTitle.trim() === '' || editTitle.trim() === editSource.title} onClick={() => void saveSourceTitle()}>{busy ? b('保存中…', 'Saving…') : b('保存', 'Save')}</button></div>
    </section></div>}
    {deleteSource === undefined ? null : <div className={css.dialogBackdrop} role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="study-delete-source-title" className={css.importDialog}><header><h2 id="study-delete-source-title">{b('永久删除文献', 'Permanently delete document')}</h2><button type="button" aria-label={b('关闭删除文献', 'Close delete dialog')} onClick={() => { setDeleteSource(undefined); setDeleteTitle('') }}>×</button></header><p>{b('将删除原文件、解析结果和相关记录，无法恢复。请输入完整书名确认：', 'This permanently removes the original, extraction output, and related records. Enter the full title to confirm:')}</p><strong>{deleteSource.title}</strong><label>{b('完整书名', 'Full title')} <input autoFocus value={deleteTitle} onChange={event => setDeleteTitle(event.currentTarget.value)} /></label><div><button type="button" onClick={() => { setDeleteSource(undefined); setDeleteTitle('') }}>{b('取消', 'Cancel')}</button><button type="button" disabled={busy || deleteTitle !== deleteSource.title} onClick={() => void permanentlyDeleteSource()}>{busy ? b('删除中…', 'Deleting…') : b('永久删除', 'Delete permanently')}</button></div></section></div>}
  </main>
}

function assetUrl(route: string, source: SourceSummary, block: StudyBlock): string | undefined {
  if (source.revisionId === undefined || block.assetPath === undefined) return undefined
  const match = /^sha256\/([a-f0-9]{64})$/i.exec(block.assetPath)
  if (match?.[1] === undefined) return undefined
  const prefix = `/${route.split('/').filter(Boolean).join('/')}`
  return `${prefix}/${encodeURIComponent(String(source.id))}/${encodeURIComponent(String(source.revisionId))}/blob/${match[1]}`
}

function BlockList({ blocks, empty, assetUrl: resolveAsset, b }: { readonly blocks: readonly StudyBlock[]; readonly empty: string; readonly assetUrl?: (block: StudyBlock) => string | undefined; readonly b: BilingualText }) {
  if (blocks.length === 0) return <p className={css.empty}>{empty}</p>
  return <div className={css.blocks}>{blocks.map(block => {
    const location = block.type === 'title' ? '' : block.sourceLocator?.kind === 'epub-xhtml' ? block.headingPath.at(-1) ?? block.sourceLocator.href : block.page > 0 ? `p. ${block.page}` : block.headingPath.join(' › ')
    const image = resolveAsset?.(block)
    const headingDepth = Math.min(6, Math.max(2, block.headingPath.length + 1))
    const listLines = block.text.split('\n').map(line => line.trim()).filter(Boolean)
    const ordered = listLines.length > 0 && listLines.every(line => /^\d+[.)]\s+/.test(line))
    const listItems = listLines.map(line => line.replace(/^(?:•|[-*]|\d+[.)])\s+/, ''))
    const tableRows = block.text.split('\n').map(row => row.split('|').map(cell => cell.trim()).filter(Boolean)).filter(row => row.length > 0)
    const body = block.type === 'title' ? createElement(`h${headingDepth}`, null, block.text)
      : block.type === 'list' ? ordered
        ? <ol>{listItems.map((item, index) => <li key={`${String(block.id)}-${index}`}>{item}</li>)}</ol>
        : <ul>{listItems.map((item, index) => <li key={`${String(block.id)}-${index}`}>{item}</li>)}</ul>
      : block.type === 'table' && tableRows.length > 0 ? <div className={css.tableWrap}><table><tbody>{tableRows.map((row, rowIndex) => <tr key={`${String(block.id)}-${rowIndex}`}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex} scope="col">{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
      : block.type === 'table' ? <pre className={css.table}>{block.text}</pre>
      : block.type === 'equation' ? <div className={css.equation}>{block.text}</div>
      : block.type === 'code' ? <pre><code>{block.text}</code></pre>
      : block.type === 'footnote' ? <aside>{block.text}</aside>
      : block.type === 'other' ? <blockquote>{block.text}</blockquote>
      : block.type === 'image' && image !== undefined ? <figure><img loading="lazy" src={image} alt={block.text || b('文献插图', 'Document illustration')} />{block.text === '' ? null : <figcaption>{block.text}</figcaption>}</figure>
      : <p>{block.text}</p>
    return <article key={String(block.id)} data-block-type={block.type}>{location === '' ? null : <small>{location}</small>}{body}</article>
  })}</div>
}
