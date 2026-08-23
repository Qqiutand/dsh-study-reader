import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewSection } from '../study/types.ts'
import { useBilingualText, type BilingualText } from './StudyLocale.tsx'

interface PdfViewport { readonly width:number; readonly height:number }
interface PdfPage { getViewport(input:{readonly scale:number}):PdfViewport; render(input:{readonly canvasContext:CanvasRenderingContext2D;readonly viewport:PdfViewport}):{promise:Promise<void>;cancel?():void}; getTextContent():Promise<{readonly items:readonly {readonly str:string;readonly transform:readonly number[]}[]}> }
interface PdfDocument { readonly numPages:number; getPage(page:number):Promise<PdfPage> }

interface PdfModule { getDocument(source:Record<string,unknown>):{promise:Promise<PdfDocument>;destroy():void}; GlobalWorkerOptions:{workerSrc:string} }
let pdfModule: Promise<PdfModule> | undefined
function loadPdf(workerUrl:string) {
  pdfModule ??= import('pdfjs-dist/build/pdf.mjs') as Promise<PdfModule>
  return pdfModule.then(pdf=>{pdf.GlobalWorkerOptions.workerSrc=workerUrl;return pdf})
}

function renderWindow(page:number,count:number):ReadonlySet<number>{
  const start=Math.max(1,page-2),end=Math.min(count,page+2)
  return new Set(Array.from({length:end-start+1},(_,index)=>start+index))
}

function PdfCanvasPage({document,page,zoom,top,onSize,b}:{readonly document:PdfDocument;readonly page:number;readonly zoom:number;readonly top:number;readonly onSize:(page:number,size:PdfViewport)=>void;readonly b:BilingualText}){
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const textRef=useRef<HTMLDivElement>(null)
  const [size,setSize]=useState({width:918,height:1188})
  const [error,setError]=useState<string>()
  useEffect(()=>{
    let disposed=false,task:{promise:Promise<void>;cancel?():void}|undefined
    void document.getPage(page).then(async pdfPage=>{
      const viewport=pdfPage.getViewport({scale:zoom/100*1.5})
      if(disposed)return
      setSize(viewport)
      onSize(page,viewport)
      const canvas=canvasRef.current,textLayer=textRef.current
      if(canvas===null||textLayer===null)return
      canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height)
      canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`
      task=pdfPage.render({canvasContext:canvas.getContext('2d')!,viewport})
      await task.promise
      const text=await pdfPage.getTextContent()
      if(disposed)return
      textLayer.replaceChildren(...text.items.map(item=>{
        const span=window.document.createElement('span')
        const x=item.transform[4]??0,y=item.transform[5]??0
        const font=Math.max(1,Math.hypot(item.transform[0]??0,item.transform[1]??0)*zoom/100*1.5)
        span.textContent=item.str
        span.style.cssText=`position:absolute;left:${x*zoom/100*1.5}px;bottom:${y*zoom/100*1.5}px;font-size:${font}px;white-space:pre;color:transparent;user-select:text`
        return span
      }))
    }).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:b('PDF 页面渲染失败','PDF page rendering failed'))})
    return()=>{disposed=true;task?.cancel?.()}
  },[document,onSize,page,zoom])
  return <section className="dsh-reader-pdf-page" data-pdf-page={page} style={{width:size.width,height:size.height,top}}>{error===undefined?<><canvas ref={canvasRef} aria-label={`${b('原版 PDF 第','Original PDF page')} ${page}`}/><div ref={textRef} className="dsh-reader-text-layer"/></>:<p role="alert">{b(`第 ${page} 页渲染失败：${error}`,`Page ${page} rendering failed: ${error}`)}</p>}</section>
}

function NativePdf({url,wasmUrl,workerUrl,page,zoom,height,onPage,pageCount}:{readonly url:string;readonly wasmUrl:string;readonly workerUrl:string;readonly page:number;readonly zoom:number;readonly height:number|string;readonly onPage:(page:number)=>void;readonly pageCount:number}){
  const b=useBilingualText()
  const host=useRef<HTMLDivElement>(null)
  const [document,setDocument]=useState<PdfDocument>()
  const [error,setError]=useState<string>()
  const [pageSizes,setPageSizes]=useState<Readonly<Record<number,PdfViewport>>>({})
  useEffect(()=>{let disposed=false,task:{promise:Promise<PdfDocument>;destroy():void}|undefined;setDocument(undefined);setError(undefined);void loadPdf(workerUrl).then(pdf=>{task=pdf.getDocument({url,wasmUrl,useWasm:true,useWorkerFetch:false});return task.promise}).then(value=>{if(!disposed)setDocument(value)}).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:b('PDF 加载失败','PDF loading failed'))});return()=>{disposed=true;task?.destroy()}},[b,url,wasmUrl,workerUrl])
  const count=document?.numPages??Math.max(1,pageCount),windowPages=useMemo(()=>renderWindow(page,count),[count,page])
  useEffect(()=>setPageSizes({}),[document,zoom])
  const onSize=useCallback((value:number,size:PdfViewport)=>setPageSizes(current=>current[value]?.width===size.width&&current[value]?.height===size.height?current:{...current,[value]:size}),[])
  const layout=useMemo(()=>{const gap=20,estimatedHeight=1188*zoom/100,offsets:number[]=[];let top=0;for(let value=1;value<=count;value+=1){offsets.push(top);top+=(pageSizes[value]?.height??estimatedHeight)+gap}return{offsets,totalHeight:Math.max(0,top-gap)}},[count,pageSizes,zoom])
  const targetTop=layout.offsets[page-1]??0
  useEffect(()=>{const root=host.current;if(root!==null&&Math.abs(root.scrollTop-targetTop)>2)root.scrollTo({top:targetTop,left:0,behavior:'auto'})},[document,page,targetTop])
  const onScroll=()=>{const root=host.current;if(root===null)return;const target=root.scrollTop+Math.min(120,root.clientHeight*.2);let low=0,high=layout.offsets.length-1;while(low<high){const middle=Math.ceil((low+high)/2);if((layout.offsets[middle]??0)<=target)low=middle;else high=middle-1}const next=Math.min(count,low+1);if(next!==page)onPage(next)}
  if(error!==undefined)return <div className="dsh-reader-error" role="alert">{b(`原版 PDF 加载失败：${error}`,`Original PDF loading failed: ${error}`)}</div>
  return <div ref={host} className="dsh-reader-scroll" style={{height}} onScroll={onScroll}>{document===undefined?<p>{b('正在载入原版 PDF…','Loading original PDF…')}</p>:<div className="dsh-reader-pdf-pages" style={{height:layout.totalHeight}}>{[...windowPages].map(value=><PdfCanvasPage key={value} document={document} page={value} zoom={zoom} top={layout.offsets[value-1]??0} onSize={onSize} b={b}/>)}</div>}</div>
}

function normalizedEpubHref(value:string):string{
  let decoded=value.split('#',1)[0]?.split('?',1)[0]??''
  try{decoded=decodeURIComponent(decoded)}catch{}
  return decoded.replace(/^\.\//u,'').replace(/^\//u,'')
}

function sameEpubHref(left:string,right:string):boolean{
  const a=normalizedEpubHref(left),b=normalizedEpubHref(right)
  return a===b||a.endsWith(`/${b}`)||b.endsWith(`/${a}`)
}

function resolveEpubHref(book:any, href:string):string {
  const spineItems=(book?.spine?.spineItems??[]) as readonly {readonly href?:string}[]
  return spineItems.find(item=>item.href!==undefined&&sameEpubHref(item.href,href))?.href??href
}

function resolveEpubSectionHref(book:any, sections:readonly PreviewSection[], index:number):string|undefined {
  const declared=sections[index]?.href
  if(declared!==undefined)return resolveEpubHref(book,declared)
  const spineItems=(book?.spine?.spineItems??[]) as readonly {readonly href?:string}[]
  return spineItems[index]?.href
}

function NativeEpub({url,section,onSection,sections,zoom,height}:{readonly url:string;readonly section:number;readonly onSection:(page:number)=>void;readonly sections:readonly PreviewSection[];readonly zoom:number;readonly height:number|string}){
  const b=useBilingualText()
  const host=useRef<HTMLDivElement>(null),rendition=useRef<any>(),bookRef=useRef<any>()
  const explicitTargetHref=useRef<string>()
  const displayedHref=useRef<string>()
  const [renditionReady,setRenditionReady]=useState(false)
  const sectionsRef=useRef(sections),sectionRef=useRef(section),onSectionRef=useRef(onSection)
  sectionsRef.current=sections;sectionRef.current=section;onSectionRef.current=onSection
  const [error,setError]=useState<string>()
  useEffect(()=>{let disposed=false,book:any;setError(undefined);setRenditionReady(false);explicitTargetHref.current=undefined;displayedHref.current=undefined;void import('epubjs').then(async module=>{if(disposed||host.current===null)return;const namespace=module as unknown as Record<string,unknown>;const direct=namespace.default;const commonJs=namespace['module.exports'];const createBook=typeof module==='function'?module:typeof direct==='function'?direct:typeof (direct as Record<string,unknown>|undefined)?.default==='function'?(direct as {default:(input:string,options?:unknown)=>any}).default:typeof commonJs==='function'?commonJs:typeof (commonJs as Record<string,unknown>|undefined)?.default==='function'?(commonJs as {default:(input:string,options?:unknown)=>any}).default:undefined;if(createBook===undefined)throw new Error(b('EPUB 引擎未导出可调用的 ePub 工厂','The EPUB engine did not export a callable ePub factory'));book=createBook(url,{openAs:'epub'});bookRef.current=book;await book.ready;if(disposed||host.current===null)return;
    // Paginated mode represents a chapter as CSS columns on one extremely
    // wide canvas. Use epub.js' continuous manager so adjacent spine items
    // are appended on demand and one vertical wheel gesture can cross chapter
    // boundaries without leaking into the outer Bookroom scroll container.
    const next=book.renderTo(host.current,{width:'100%',height:'100%',flow:'scrolled',manager:'continuous',spread:'none',allowScriptedContent:false});rendition.current=next;next.spread?.('none');next.themes.default?.({
      'html':{'box-sizing':'border-box !important','width':'100% !important','max-width':'100% !important','overflow-x':'hidden !important','column-count':'1 !important','column-width':'auto !important'},
      'body':{'box-sizing':'border-box !important','width':'min(100%, 860px) !important','max-width':'860px !important','min-width':'0 !important','margin':'0 auto !important','padding':'clamp(24px, 5vw, 64px) !important','line-height':'1.65 !important','overflow-x':'hidden !important','column-count':'1 !important','column-width':'auto !important','column-gap':'0 !important'},
      'body > *':{'max-width':'100% !important'},
      'img, svg, video, canvas':{'max-width':'100% !important','height':'auto !important'},
      'table, pre':{'max-width':'100% !important','overflow-x':'auto !important'},
    });next.themes.fontSize(`${zoom}%`);next.on('displayError',(cause:unknown)=>{if(!disposed)setError(cause instanceof Error?cause.message:b('EPUB 章节渲染失败','EPUB section rendering failed'))});next.on('relocated',(location:{start?:{href?:string}})=>{const href=location.start?.href;if(href===undefined)return;displayedHref.current=href;const target=explicitTargetHref.current;if(target!==undefined&&!sameEpubHref(href,target))return;if(target!==undefined)explicitTargetHref.current=undefined;const index=sectionsRef.current.findIndex((_item,itemIndex)=>{const resolved=resolveEpubSectionHref(bookRef.current,sectionsRef.current,itemIndex);return resolved!==undefined&&sameEpubHref(resolved,href)});if(index>=0&&index!==sectionRef.current)onSectionRef.current(index)});const initialTarget=resolveEpubSectionHref(book,sectionsRef.current,sectionRef.current);if(initialTarget===undefined)throw new Error(b('EPUB 章节缺少可用路径','The EPUB section has no usable path'));explicitTargetHref.current=initialTarget;await next.display(initialTarget);if(disposed)return;displayedHref.current=initialTarget;explicitTargetHref.current=undefined;setRenditionReady(true)}).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:b('EPUB 加载失败','EPUB loading failed'))});return()=>{disposed=true;explicitTargetHref.current=undefined;displayedHref.current=undefined;rendition.current?.destroy?.();rendition.current=undefined;bookRef.current=undefined;book?.destroy?.()}},[b,url])
  useEffect(()=>{rendition.current?.themes.fontSize(`${zoom}%`)},[zoom])
  useEffect(()=>{if(!renditionReady)return;const resolved=resolveEpubSectionHref(bookRef.current,sections,section);if(resolved===undefined){setError(b('EPUB 章节缺少可用路径','The EPUB section has no usable path'));return}if(displayedHref.current!==undefined&&sameEpubHref(displayedHref.current,resolved))return;explicitTargetHref.current=resolved;void rendition.current?.display(resolved).then(()=>{displayedHref.current=resolved;if(explicitTargetHref.current===resolved)explicitTargetHref.current=undefined}).catch((cause:unknown)=>{if(explicitTargetHref.current===resolved)explicitTargetHref.current=undefined;setError(cause instanceof Error?cause.message:b('EPUB 章节跳转失败','EPUB section navigation failed'))})},[b,renditionReady,section,sections])
  if(error!==undefined)return <div className="dsh-reader-error" role="alert">{b(`原版 EPUB 加载失败：${error}`,`Original EPUB loading failed: ${error}`)}</div>
  return <div className="dsh-reader-epub" style={{height}}><div ref={host}/></div>
}

export const OriginalDocumentFrame=memo(function OriginalDocumentFrame(props:{readonly format:'pdf'|'epub';readonly url:string;readonly pdfjsWasmUrl?:string;readonly pdfjsWorkerUrl?:string;readonly page:number;readonly onPage:(page:number)=>void;readonly pageCount:number;readonly sections:readonly PreviewSection[];readonly zoom:number;readonly height:number|string}){
  return props.format==='pdf'?<NativePdf url={props.url} wasmUrl={props.pdfjsWasmUrl??'/study-reader/assets/_pdfjs/wasm/'} workerUrl={props.pdfjsWorkerUrl??'/study-reader/assets/_pdfjs/worker/pdf.worker.mjs'} page={props.page} onPage={props.onPage} pageCount={props.pageCount} zoom={props.zoom} height={props.height}/>:<NativeEpub url={props.url} section={Math.max(0,props.page-1)} onSection={value=>props.onPage(value+1)} sections={props.sections} zoom={props.zoom} height={props.height}/>
})
