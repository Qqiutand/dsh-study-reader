declare module 'epubjs' {
  const ePub: (url: string) => any
  export default ePub
}

declare module 'pdfjs-dist/build/pdf.mjs' {
  export function getDocument(source: Record<string, unknown>): any
  export const GlobalWorkerOptions: { workerSrc: string }
}
