// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingWorkspace } from '../src/client/ReadingWorkspace.tsx'
import { READING_WORKSPACE_CSS } from '../src/client/ReadingWorkspace.css.ts'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })
async function documentButton(title: string): Promise<HTMLButtonElement> {
  const heading = await screen.findByText(title, { selector: 'strong' })
  const button = heading.closest('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error(`document card button not found: ${title}`)
  return button
}
function remote(overrides: Record<string, unknown> = {}) { const api:any = {
  bootstrap: vi.fn(async () => ({ ok:true,value:{assetRoute:'/assets',defaultLanguage:'ch',upload:{maxFileBytes:1,acceptExtensions:[]},cognitive:{pollMs:1,timeoutMs:1}} })),
  getSessionSourceSelection: vi.fn(async () => ({ok:true,value:{schemaVersion:1,sessionId:'s',version:0,updatedAt:0}})),
  setSessionSourceSelection: vi.fn(async (request:any) => ({ok:true,value:{schemaVersion:1,sessionId:'s',sourceId:request.sourceId,revisionId:request.revisionId,version:1,updatedAt:1}})),
  setSourceAccess: vi.fn(async (request:any) => ({ok:true,value:{granted:request.granted,selection:{schemaVersion:1,sessionId:'s',version:1,updatedAt:1}}})),
  openSourceForSession: vi.fn(async (request:any) => ({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',sourceId:request.sourceId,revisionId:request.revisionId,version:1,updatedAt:1},source:{id:request.sourceId,title:'Book',recordVersion:1,kind:'book',format:'epub',revisionId:request.revisionId,granted:true}}})),
  listSources: vi.fn(async () => ({ok:true,value:[{id:'src',title:'Book',recordVersion:1,kind:'book',format:'epub',revisionId:'rev'}]})),
  read: vi.fn(async () => ({ok:true,value:{blocks:[{id:'b',ordinal:0,page:1,headingPath:[],text:'bounded'}],truncated:true,nextCursor:12}})),
  search: vi.fn(async () => ({ok:true,value:{blocks:[{id:'hit',ordinal:2,page:3,headingPath:[],text:'result'}],total:1,truncated:false}})), ...overrides,
  executeStudioCommand: vi.fn(async () => ({ok:true,value:{accepted:true}})),
  moveSource: vi.fn(async (request:any) => ({ok:true,value:{sourceId:request.sourceId,folderId:request.folderId,version:4,updatedAt:4}})),
  renameSource: vi.fn(async (request:any) => ({ok:true,value:{accepted:true,sourceId:request.sourceId,title:request.title,recordVersion:4}})),
  listImportStatuses: vi.fn(async () => ({ok:true,value:[]})),
  ...overrides,
}; api.getLibrarySnapshot ??= vi.fn(async()=>{
  const [bootstrap,selection,sources]=await Promise.all([api.bootstrap(),api.getSessionSourceSelection({sessionId:'s'}),api.listSources({scope:'library',sessionId:'s'})])
  return {ok:true,value:{selection:selection.value,sources:sources.value,selectedSource:sources.value.find((source:any)=>source.id===selection.value.sourceId),assetRoute:bootstrap.value.assetRoute,defaultLanguage:bootstrap.value.defaultLanguage}}
}); api.listAssets ??= vi.fn(async(request:any)=>{
  const listed=await api.listSources({scope:'library',sessionId:request.sessionId,query:request.query})
  const normalized=String(request.query??'').trim().toLocaleLowerCase()
  const values=normalized===''?listed.value:listed.value.filter((source:any)=>source.title.toLocaleLowerCase().includes(normalized)||source.authors?.some((author:string)=>author.toLocaleLowerCase().includes(normalized)))
  return {ok:true,value:{assets:values.map((source:any)=>({id:String(source.id),kind:'source',namespace:'library',name:source.title,recordVersion:source.recordVersion,badges:[],source})),total:values.length}}
}); api.getSourcePreview ??= vi.fn(async(request:any)=>{
  const read=await api.read({sessionId:request.sessionId,sourceId:request.sourceId,revisionId:request.revisionId,range:{kind:'blocks',start:0,end:40}})
  return {ok:true,value:{kind:'epub',title:'Book',sections:[],blocks:read.value.blocks,truncated:read.value.truncated}}
}); return api }

describe('lightweight library workspace', () => {
  it('reserves the flexible library height for document cards', () => {
    expect(READING_WORKSPACE_CSS).toContain('grid-template-rows:auto clamp(88px,16vh,120px) minmax(0,1fr)')
    expect(READING_WORKSPACE_CSS).toContain('.dsh-library-ai-shelf{min-height:0;max-height:none')
    expect(READING_WORKSPACE_CSS).toContain('.dsh-library-notice{margin:0 0 10px')
  })
  it('hydrates without writing selection or automatically opening a document', async () => {
    const api=remote({getSessionSourceSelection:vi.fn(async()=>({ok:true,value:{schemaVersion:1,sessionId:'s',sourceId:'src',revisionId:'rev',version:2,updatedAt:1}}))})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />); expect(await screen.findByRole('heading',{name:'选择一本文献'})).toBeDefined()
    expect(api.setSessionSourceSelection).not.toHaveBeenCalled(); expect(api.openSourceForSession).not.toHaveBeenCalled(); expect(api.getSourcePreview).not.toHaveBeenCalled()
  })
  it('previews on explicit selection without changing conversation access', async () => {
    const api=remote(); render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await documentButton('Book')); await waitFor(()=>expect(api.getSourcePreview).toHaveBeenCalledTimes(1))
    expect(api.openSourceForSession).not.toHaveBeenCalled()
    expect(api.setSourceAccess).not.toHaveBeenCalled()
    expect(screen.getByRole('button',{name:'收起书库'}).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('complementary',{name:'文献列表'})).toBeTruthy()
    expect(screen.queryByLabelText('在本文中查找')).toBeNull()
    expect(api.search).not.toHaveBeenCalled()
  })
  it('opens a preview from the compact conversation shelf without changing access', async () => {
    const api=remote(); render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await screen.findByRole('button',{name:'预览《Book》'}))
    await waitFor(()=>expect(api.getSourcePreview).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('bounded')).toBeDefined()
    expect(api.getSourcePreview.mock.calls[0]![0]).toMatchObject({sessionId:'s',sourceId:'src',revisionId:'rev'})
    expect(api.openSourceForSession).not.toHaveBeenCalled()
    expect(api.setSourceAccess).not.toHaveBeenCalled()
  })
  it('pages the Host library projection instead of capping the visible library at the bootstrap snapshot', async () => {
    const makeSource=(id:string,title:string)=>({id,title,recordVersion:1,kind:'book',format:'epub',revisionId:`rev-${id}`,granted:true})
    const first=Array.from({length:40},(_,index)=>makeSource(`src-${index}`,`Book ${index}`))
    const last=makeSource('src-101','Book 101')
    const listAssets=vi.fn(async(request:any)=>request.cursor===undefined
      ? {ok:true,value:{assets:first.map(source=>({id:source.id,kind:'source',namespace:'library',name:source.title,recordVersion:1,badges:[],source})),total:101,nextCursor:'40'}}
      : {ok:true,value:{assets:[{id:last.id,kind:'source',namespace:'library',name:last.title,recordVersion:1,badges:[],source:last}],total:101}})
    const api=remote({listSources:vi.fn(async()=>({ok:true,value:[]})),listAssets})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    expect(await documentButton('Book 0')).toBeDefined()
    fireEvent.click(screen.getByRole('button',{name:'加载更多'}))
    expect(await documentButton('Book 101')).toBeDefined()
    expect(listAssets.mock.calls.map(call=>call[0].cursor)).toEqual([undefined,'40'])
  })
  it('moves a library asset through the unified Studio command dialog', async () => {
    const source={id:'src',title:'Book',recordVersion:7,kind:'book',format:'epub',revisionId:'rev',granted:true}
    const listAssets=vi.fn(async()=>({ok:true,value:{assets:[{id:'src',kind:'source',namespace:'library',folderId:'old',name:'Book',recordVersion:3,badges:[],source}],total:1}}))
    const api=remote({listAssets,getLibrarySnapshot:vi.fn(async()=>({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',version:0,updatedAt:0},sources:[source],assetRoute:'/assets',defaultLanguage:'ch',folders:[{id:'old',name:'Old'},{id:'new',name:'New'}],activeImports:[]}}))})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await screen.findByLabelText('Book 更多操作'))
    fireEvent.click(screen.getByRole('menuitem',{name:'移动到…'}))
    const dialog=await screen.findByRole('dialog',{name:'移动“Book”'})
    fireEvent.change(dialog.querySelector('select')!,{target:{value:'new'}})
    fireEvent.click(screen.getByRole('button',{name:'移动'}))
    await waitFor(()=>expect(api.moveSource).toHaveBeenCalledTimes(1))
    expect(api.moveSource.mock.calls[0]![0]).toMatchObject({sessionId:'s',sourceId:'src',expectedVersion:3,folderId:'new'})
  })
  it('closes the document menu on outside click and edits the display title', async () => {
    const source={id:'src',title:'Book',originalFileName:'book.epub',recordVersion:7,kind:'book',format:'epub',revisionId:'rev',granted:true}
    const renameSource=vi.fn(async(request:any)=>({ok:true,value:{accepted:true,sourceId:request.sourceId,title:request.title,recordVersion:8}}))
    const api=remote({renameSource,listSources:vi.fn(async()=>({ok:true,value:[source]}))})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    const more=await screen.findByLabelText('Book 更多操作')
    fireEvent.click(more)
    expect(screen.getByRole('menuitem',{name:'编辑标题…'})).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem',{name:'编辑标题…'})).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem',{name:'编辑标题…'}))
    const dialog=await screen.findByRole('dialog',{name:'编辑文献标题'})
    expect(dialog.textContent).toContain('原始文件名：book.epub')
    fireEvent.change(screen.getByLabelText('显示标题'),{target:{value:'Renamed book'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(()=>expect(renameSource).toHaveBeenCalledTimes(1))
    expect(renameSource.mock.calls[0]![0]).toMatchObject({sessionId:'s',sourceId:'src',title:'Renamed book',expectedVersion:7})
  })
  it('shows one left-hand folder list and previews without granting conversation access', async () => {
    const oldSource={id:'old',title:'Old folder book',recordVersion:1,kind:'book',format:'pdf',revisionId:'old-rev',granted:true}
    const folderSource={id:'folder-book',title:'Folder book',recordVersion:1,kind:'book',format:'epub',revisionId:'folder-rev',granted:false}
    const openSourceForSession=vi.fn()
    const api=remote({
      getLibrarySnapshot:vi.fn(async()=>({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',sourceId:'old',revisionId:'old-rev',version:1,updatedAt:1},selectedSource:oldSource,sources:[oldSource,folderSource],assetRoute:'/assets',defaultLanguage:'ch',folders:[{id:'folder',name:'Folder'}],activeImports:[]}})),
      listAssets:vi.fn(async()=>({ok:true,value:{assets:[{id:'folder-book',kind:'source',namespace:'library',folderId:'folder',name:'Folder book',recordVersion:1,badges:[],source:folderSource}],total:1}})),
      openSourceForSession,
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" folderId="folder" />)
    expect(await screen.findByRole('heading',{name:'选择一本文献'})).toBeDefined()
    expect(openSourceForSession).not.toHaveBeenCalled()
    fireEvent.click(await documentButton('Folder book'))
    expect(await screen.findByText('bounded')).toBeDefined()
    expect(openSourceForSession).not.toHaveBeenCalled()
    expect(api.setSourceAccess).not.toHaveBeenCalled()
  })
  it('requires the exact title before permanently deleting a document', async () => {
    const source={id:'src',title:'Book',recordVersion:7,kind:'book',format:'epub',revisionId:'rev',granted:true}
    const executeManagementCommand=vi.fn(async()=>({ok:true,value:{accepted:true,proposal:{id:'proposal',sessionId:'s',kind:'delete-source',targetId:'src',title:'Book',targetVersion:7,commandPayloadHash:'x',expiresAt:Date.now()+10000,createdAt:1,state:'pending',version:1}}}))
    const decideManagementProposal=vi.fn(async()=>({ok:true,value:{}}))
    const api=remote({listSources:vi.fn(async()=>({ok:true,value:[source]})),executeManagementCommand,decideManagementProposal})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await screen.findByLabelText('Book 更多操作'))
    fireEvent.click(screen.getByRole('menuitem',{name:'删除文献…'}))
    const confirm=screen.getByRole('button',{name:'永久删除'}) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('完整书名'),{target:{value:'Book'}})
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(()=>expect(decideManagementProposal).toHaveBeenCalledTimes(1))
    const proposalRequest=(executeManagementCommand.mock.calls as unknown as readonly [readonly [any]])[0]![0]
    const decisionRequest=(decideManagementProposal.mock.calls as unknown as readonly [readonly [any]])[0]![0]
    expect(proposalRequest.command).toMatchObject({kind:'create-proposal',proposalKind:'delete-source',targetId:'src',targetVersion:7})
    expect(decisionRequest).toMatchObject({proposalId:'proposal',decision:'approved',expectedTitle:'Book'})
  })
  it('keeps the current preview open when conversation access is removed', async () => {
    const api=remote({
      getSessionSourceSelection:vi.fn(async()=>({ok:true,value:{schemaVersion:1,sessionId:'s',sourceId:'src',revisionId:'rev',version:3,updatedAt:1}})),
      listSources:vi.fn(async()=>({ok:true,value:[
        {id:'src',title:'Book A',recordVersion:1,kind:'book',format:'epub',revisionId:'rev',granted:true},
        {id:'src-2',title:'Book B',recordVersion:1,kind:'book',format:'epub',revisionId:'rev-2',granted:true},
      ]})),
      setSourceAccess:vi.fn(async()=>({ok:true,value:{granted:false,selection:{schemaVersion:1,sessionId:'s',version:4,updatedAt:2}}})),
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await documentButton('Book A'))
    expect(await screen.findByText('bounded')).toBeDefined()
    fireEvent.click((await screen.findAllByRole('button',{name:'移出本次对话'}))[0]!)
    await waitFor(()=>expect(api.setSourceAccess).toHaveBeenCalledTimes(1))
    expect(screen.getByText('bounded')).toBeDefined()
    expect(api.openSourceForSession).not.toHaveBeenCalled()
  })
  it('offers explicit PDF recognition languages', async () => {
    render(<ReadingWorkspace studyRemote={remote()} sessionId="s" />)
    fireEvent.click(await screen.findByRole('button',{name:'导入文献'}))
    const select=await screen.findByLabelText('PDF / MinerU 识别语言') as HTMLSelectElement
    expect([...select.options].map(option=>option.value)).toEqual(['ch','en','korean','japan','french','german','spanish','russian'])
  })
  it('admits multiple selected files sequentially into the chosen folder', async () => {
    let preparedCount=0
    const prepareUpload=vi.fn(async(request:any)=>{
      preparedCount+=1
      return {ok:true,value:{importId:`import-${preparedCount}`,uploadPath:`/upload/${preparedCount}`,uploadToken:`${request.fileName}-token`}}
    })
    const importStatus=vi.fn(async(request:any)=>({ok:true,value:{
      importId:request.importId,
      state:'queued',
      displayName:request.importId==='import-1'?'First.pdf':'Second.epub',
      availableActions:[],
      renewRequired:false,
    }}))
    const uploadFetch=vi.fn(async()=>new Response(null,{status:200}))
    vi.stubGlobal('fetch',uploadFetch)
    const api=remote({
      prepareUpload,
      importStatus,
      listSources:vi.fn(async()=>({ok:true,value:[]})),
      getLibrarySnapshot:vi.fn(async()=>({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',version:0,updatedAt:0},sources:[],assetRoute:'/assets',defaultLanguage:'ch',folders:[{id:'research',name:'Research'}],activeImports:[]}})),
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await screen.findByRole('button',{name:'导入文献'}))
    fireEvent.change(await screen.findByLabelText('导入目标文件夹'),{target:{value:'research'}})
    const input=screen.getByLabelText('选择要导入的文献（可多选）') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const first=new File([new Uint8Array([1])],'First.pdf',{type:'application/pdf'})
    const second=new File([new Uint8Array([2])],'Second.epub',{type:'application/epub+zip'})
    fireEvent.change(input,{target:{files:[first,second]}})

    await waitFor(()=>expect(prepareUpload).toHaveBeenCalledTimes(2))
    expect(prepareUpload.mock.calls.map(call=>call[0])).toEqual([
      expect.objectContaining({fileName:'First.pdf',targetFolderId:'research',sessionId:'s'}),
      expect.objectContaining({fileName:'Second.epub',targetFolderId:'research',sessionId:'s'}),
    ])
    expect(importStatus.mock.calls.map(call=>call[0].importId)).toEqual(['import-1','import-2'])
    expect(uploadFetch).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('已提交 2 篇文献，后台正在处理。')).toBeDefined()
  })
  it('continues a multi-file import after one file is rejected', async () => {
    const prepareUpload=vi.fn()
      .mockResolvedValueOnce({ok:false,error:{code:'FILE_TYPE_UNSUPPORTED',message:'unsupported'}})
      .mockResolvedValueOnce({ok:true,value:{importId:'import-good',uploadPath:'/upload/good',uploadToken:'token-good'}})
    const importStatus=vi.fn(async()=>({ok:true,value:{importId:'import-good',state:'queued',displayName:'Good.pdf',availableActions:[],renewRequired:false}}))
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:200})))
    const api=remote({prepareUpload,importStatus,listSources:vi.fn(async()=>({ok:true,value:[]}))})
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await screen.findByRole('button',{name:'导入文献'}))
    const input=screen.getByLabelText('选择要导入的文献（可多选）')
    fireEvent.change(input,{target:{files:[
      new File([new Uint8Array([1])],'Bad.bin'),
      new File([new Uint8Array([2])],'Good.pdf',{type:'application/pdf'}),
    ]}})

    await waitFor(()=>expect(prepareUpload).toHaveBeenCalledTimes(2))
    expect(importStatus).toHaveBeenCalledWith({importId:'import-good'})
    expect(await screen.findByText(/已提交 1 篇文献，1 篇失败：Bad\.bin: FILE_TYPE_UNSUPPORTED/u)).toBeDefined()
  })
  it('refreshes import folder choices after an asset-tree change and lists currently visible documents', async () => {
    const source={id:'src',title:'Visible Book',recordVersion:1,kind:'book',format:'pdf',revisionId:'rev',granted:true}
    const getLibrarySnapshot=vi.fn()
      .mockResolvedValueOnce({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',version:0,updatedAt:0},sources:[source],assetRoute:'/assets',defaultLanguage:'ch',folders:[],activeImports:[]}})
      .mockResolvedValueOnce({ok:true,value:{selection:{schemaVersion:1,sessionId:'s',version:0,updatedAt:0},sources:[source],assetRoute:'/assets',defaultLanguage:'ch',folders:[{id:'camera',name:'camera'}],activeImports:[]}})
    const api=remote({listSources:vi.fn(async()=>({ok:true,value:[source]})),getLibrarySnapshot})
    const view=render(<ReadingWorkspace studyRemote={api} sessionId="s" refreshVersion={0} />)
    expect((await screen.findByRole('region',{name:'全部文献'})).textContent).toContain('Visible Book')
    expect(screen.getByRole('region',{name:'本次对话的文献'}).textContent).toContain('Visible Book')
    fireEvent.click(await screen.findByRole('button',{name:'导入文献'}))
    expect(screen.getByRole('dialog',{name:'导入文献'}).querySelector('.dsh-library-visible-documents')).toBeNull()
    expect(screen.queryByRole('option',{name:'camera'})).toBeNull()
    view.rerender(<ReadingWorkspace studyRemote={api} sessionId="s" refreshVersion={1} />)
    expect(await screen.findByRole('option',{name:'camera'})).toBeDefined()
    expect(getLibrarySnapshot).toHaveBeenCalledTimes(2)
  })
  it('previews an ungranted source without granting it and renders semantic EPUB blocks', async () => {
    const hash='a'.repeat(64)
    const api=remote({
      listSources:vi.fn(async()=>({ok:true,value:[{id:'src',title:'EPUB Book',recordVersion:1,kind:'book',format:'epub',revisionId:'rev',granted:false}]})),
      read:vi.fn(async()=>({ok:true,value:{blocks:[
        {id:'title',ordinal:0,page:0,providerPageIndex:-1,type:'title',headingPath:['Chapter One'],text:'Chapter One',sourceLocator:{kind:'epub-xhtml',href:'chapter.xhtml',spineIndex:0,startOffset:0,endOffset:11}},
        {id:'image',ordinal:1,page:0,providerPageIndex:-1,type:'image',headingPath:['Chapter One'],text:'Diagram',assetPath:`sha256/${hash}`,sourceLocator:{kind:'epub-xhtml',href:'chapter.xhtml',spineIndex:0,startOffset:12,endOffset:19}},
      ],truncated:true,nextCursor:2}})),
      listImportStatuses:vi.fn(async()=>({ok:true,value:[{importId:'done',displayName:'EPUB Book',state:'ready'}]})),
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    expect(screen.queryByText('EPUB Book · 已就绪')).toBeNull()
    fireEvent.click(await documentButton('EPUB Book'))
    await waitFor(()=>expect(api.getSourcePreview).toHaveBeenCalledTimes(1))
    expect(api.openSourceForSession).not.toHaveBeenCalled()
    expect(api.setSourceAccess).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading',{name:'Chapter One',level:2})).toBeDefined()
    expect(screen.getByRole('img',{name:'Diagram'}).getAttribute('src')).toContain(`/assets/src/rev/blob/${hash}`)
    expect(screen.queryByText('输入关键词，在当前文献中查找相关段落。')).toBeNull()
  })

  it('clears old preview content immediately when the next document is delayed or fails', async () => {
    let rejectSecond!: (reason: Error) => void
    const delayed = new Promise((_resolve, reject) => { rejectSecond = reject })
    const getSourcePreview = vi.fn()
      .mockResolvedValueOnce({ok:true,value:{kind:'epub',title:'Book A',sections:[],blocks:[{id:'a',ordinal:0,page:1,providerPageIndex:0,type:'paragraph',headingPath:[],text:'A-only text'}],truncated:false}})
      .mockReturnValueOnce(delayed)
    const api=remote({
      getSourcePreview,
      listSources:vi.fn(async()=>({ok:true,value:[
        {id:'a',title:'Book A',recordVersion:1,kind:'book',format:'epub',revisionId:'ra',granted:true},
        {id:'b',title:'Book B',recordVersion:1,kind:'book',format:'epub',revisionId:'rb',granted:true},
      ]})),
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await documentButton('Book A'))
    expect(await screen.findByText('A-only text')).toBeDefined()
    fireEvent.click(await documentButton('Book B'))
    await waitFor(()=>expect(screen.queryByText('A-only text')).toBeNull())
    rejectSecond(new Error('B preview failed'))
    expect(await screen.findByText('B preview failed')).toBeDefined()
    expect(screen.queryByText('A-only text')).toBeNull()
  })

  it('keeps the verified native PDF viewer mounted and exposes MinerU as an explicit layer', async () => {
    vi.stubGlobal('fetch', vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]),{status:206,headers:{'content-type':'application/pdf'}})))
    const api=remote({
      getSessionSourceSelection:vi.fn(async()=>({ok:true,value:{schemaVersion:1,sessionId:'s',sourceId:'pdf',revisionId:'rpdf',version:1,updatedAt:1}})),
      listSources:vi.fn(async()=>({ok:true,value:[{id:'pdf',title:'Paper',recordVersion:1,kind:'paper',format:'pdf',revisionId:'rpdf',granted:true}]})),
      getSourcePreview:vi.fn(async()=>({ok:true,value:{kind:'pdf',title:'Paper',originalUrl:'/assets/pdf/rpdf/original',semanticExportUrl:'/assets/pdf/rpdf/mineru-export',pageCount:3,semanticAvailable:true,sections:[],blocks:[{id:'m',ordinal:0,page:1,providerPageIndex:0,type:'paragraph',headingPath:[],text:'MinerU normalized paragraph'}],truncated:false}})),
    })
    render(<ReadingWorkspace studyRemote={api} sessionId="s" />)
    fireEvent.click(await documentButton('Paper'))
    expect(await screen.findByRole('button',{name:'原版 PDF'})).toBeDefined()
    const listResize=screen.getByRole('separator',{name:'调整文献列表宽度'})
    fireEvent.click(screen.getByRole('button',{name:'目录'}))
    const outlineResize=screen.getByRole('separator',{name:'调整章节目录宽度'})
    expect(outlineResize.compareDocumentPosition(screen.getByRole('complementary',{name:'章节目录'})) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const beforeWidth=Number.parseInt(getComputedStyle(document.querySelector('main.dsh-library')!).getPropertyValue('--dsh-library-list-width'),10)
    fireEvent.keyDown(listResize,{key:'ArrowRight'})
    expect(document.querySelector('main.dsh-library')?.getAttribute('style')).toContain(`--dsh-library-list-width: ${beforeWidth+16}px`)
    expect(screen.getByRole('button',{name:'原版 PDF'}).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button',{name:'MinerU 结构层'}))
    expect(await screen.findByText('MinerU normalized paragraph')).toBeDefined()
    expect(screen.getByRole('heading',{name:'结构化内容'})).toBeDefined()
    expect(screen.getByRole('button',{name:'MinerU 结构层'}).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('link',{name:'导出识别结果'}).getAttribute('href')).toBe('/assets/pdf/rpdf/mineru-export')
  })
})
