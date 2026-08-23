/** Write a small, valid six-page PDF without adding a fixture dependency. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const target = process.argv[2]
if (target === undefined || target.length === 0) throw new Error('usage: build-six-page-pdf.mjs <output.pdf>')

const objects = new Map()
objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
objects.set(2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] /Count 6 >>')
for (let page = 1; page <= 6; page += 1) {
  const pageObject = page + 2
  const contentObject = page + 8
  // The saturated marker lets browser acceptance distinguish a painted PDF
  // page from Chromium's dark viewer chrome.
  const content = `q\n1 0 0 rg\n72 580 220 100 re\nf\nQ\nBT\n/F1 24 Tf\n72 720 Td\n(E2E original-only PDF page ${page}) Tj\nET\n`
  objects.set(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 15 0 R >> >> /Contents ${contentObject} 0 R >>`)
  objects.set(contentObject, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`)
}
objects.set(15, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
const offsets = [0]
for (let objectNumber = 1; objectNumber <= 15; objectNumber += 1) {
  offsets[objectNumber] = Buffer.byteLength(pdf, 'binary')
  pdf += `${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`
}
const xrefOffset = Buffer.byteLength(pdf, 'binary')
pdf += 'xref\n0 16\n0000000000 65535 f \n'
for (let objectNumber = 1; objectNumber <= 15; objectNumber += 1) {
  pdf += `${String(offsets[objectNumber]).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size 16 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

const output = resolve(target)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.from(pdf, 'binary'))
