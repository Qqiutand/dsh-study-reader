/** EPUB 2/3 semantic normalization and safety regressions. */

import { describe, expect, it } from 'vitest'
import { normalizeEpubEntries, parseXhtmlBlocks, decodeEntities } from '../src/study/epub.ts'
import type { ArchiveEntry } from '../src/study/normalize.ts'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const entry = (name: string, data: Uint8Array): ArchiveEntry => ({ name, size: data.byteLength, data })

function fixture(extra: readonly ArchiveEntry[] = []): ArchiveEntry[] {
  return [
    entry('mimetype', bytes('application/epub+zip')),
    entry('META-INF/container.xml', bytes(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )),
    entry('OEBPS/content.opf', bytes(`
      <package xmlns:dc="http://purl.org/dc/elements/1.1/">
        <metadata><dc:title>测试&amp;研读</dc:title><dc:creator>作者甲</dc:creator><dc:creator>Author B</dc:creator></metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="img" href="images/diagram.png" media-type="image/png"/>
        </manifest>
        <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
      </package>
    `)),
    entry('OEBPS/nav.xhtml', bytes(`
      <html><body><nav><ol>
        <li><a href="text/ch1.xhtml#start">第一章：基础</a></li>
        <li><a href="text/ch2.xhtml">第二章：应用</a></li>
      </ol></nav></body></html>
    `)),
    entry('OEBPS/text/ch1.xhtml', bytes(`
      <html><body>
        <script>window.evil = 'SCRIPT-MUST-NOT-APPEAR'</script>
        <h1 id="start">核心 &amp; 起点</h1>
        <p>这是 <strong>第一段</strong>。</p>
        <img src="../images/diagram.png" alt="局部图示"/>
        <img src="https://example.com/tracker.png" alt="远程追踪图"/>
      </body></html>
    `)),
    entry('OEBPS/text/ch2.xhtml', bytes(`
      <html><body>
        <p>第二章正文。</p>
        <ul><li>要点甲</li><li>要点乙</li></ul>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      </body></html>
    `)),
    entry('OEBPS/images/diagram.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ...extra,
  ]
}

describe('normalizeEpubEntries', () => {
  it('projects spine XHTML onto deterministic blocks and remaps local images', async () => {
    const persist = async (_data: Uint8Array, name: string) => `sha256/${name}` as const
    const result = await normalizeEpubEntries(fixture(), persist)
    const again = await normalizeEpubEntries(fixture(), persist)

    expect(result.title).toBe('测试&研读')
    expect(result.authors).toEqual(['作者甲', 'Author B'])
    expect(result.spineCount).toBe(2)
    expect(result.pageCount).toBe(2)
    expect(result.outline.map(item => item.title)).toContain('第二章：应用')
    expect(result.blocks.some(block => block.page === 2 && block.type === 'table')).toBe(true)
    expect(result.blocks.find(block => block.page === 2 && block.type === 'list')?.text).toBe('• 要点甲\n• 要点乙')
    expect(result.blocks.find(block => block.page === 2 && block.type === 'table')?.text).toBe('A | B\n1 | 2')
    expect(result.blocks.find(block => block.type === 'image')?.assetPath).toBe('sha256/diagram.png')
    expect(result.blocks.some(block => block.text.includes('SCRIPT-MUST-NOT-APPEAR'))).toBe(false)
    expect(result.blocks.some(block => block.text.includes('远程追踪图'))).toBe(false)
    expect(result.blocks.find(block => block.text === '这是 第一段。')?.sourceLocator).toMatchObject({
      kind: 'epub-xhtml', href: 'text/ch1.xhtml', spineIndex: 0,
    })
    expect(result.blocks.find(block => block.page === 2 && block.sourceLocator !== undefined)?.sourceLocator).toMatchObject({ href: 'text/ch2.xhtml', spineIndex: 1 })
    expect(again.blocks.map(block => block.id)).toEqual(result.blocks.map(block => block.id))
  })

  it('rejects encrypted spine resources while tolerating ordinary unencrypted EPUBs', async () => {
    const encryption = entry('META-INF/encryption.xml', bytes(
      '<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData></EncryptedData></encryption>',
    ))
    await expect(normalizeEpubEntries(fixture([encryption]), async () => 'sha256/x' as const))
      .rejects.toMatchObject({ code: 'EPUB_ENCRYPTED' })
  })

  it('accepts an EPUB whose publisher marked every prose spine item linear=no, while excluding a nav document in the spine', async () => {
    const entries = fixture().map(value => value.name === 'OEBPS/content.opf'
      ? entry(value.name, bytes(new TextDecoder().decode(value.data).replace(
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>',
        '<spine><itemref idref="nav"/><itemref idref="c1" linear="no"/><itemref idref="c2" linear="no"/></spine>',
      )))
      : value)
    const result = await normalizeEpubEntries(entries, async () => 'sha256/x' as const)
    expect(result.spineCount).toBe(2)
    expect(result.pageCount).toBe(2)
    expect(result.blocks.some(block => block.text.includes('核心 & 起点'))).toBe(true)
    expect(result.blocks.some(block => block.text.includes('第二章正文。'))).toBe(true)
    expect(result.blocks.some(block => block.text.includes('第一章：基础 第二章：应用'))).toBe(false)
  })

  it('restarts the outline at each spine resource even when its first heading is styled below h1', async () => {
    const entries = fixture().map(value => value.name === 'OEBPS/text/ch1.xhtml'
      ? entry(value.name, bytes('<html><body><h2>前一文档</h2><p>甲。</p></body></html>'))
      : value.name === 'OEBPS/text/ch2.xhtml'
        ? entry(value.name, bytes('<html><body><h2>后一文档</h2><p>乙。</p></body></html>'))
        : value)
    const result = await normalizeEpubEntries(entries, async () => 'sha256/x' as const)
    const secondRoot = result.blocks.find(block => block.text === '后一文档')
    const secondParagraph = result.blocks.find(block => block.text === '乙。')

    expect(secondRoot).toMatchObject({ type: 'title', headingPath: [] })
    expect(secondParagraph?.headingPath).toEqual(['后一文档'])
  })

  it('keeps safe OPF-relative parent hrefs for reader navigation and rejects external manifest hrefs', async () => {
    const nested = fixture().map(value => value.name === 'OEBPS/content.opf'
      ? entry(value.name, bytes(new TextDecoder().decode(value.data).replace('href="text/ch1.xhtml"', 'href="../OEBPS/text/ch1.xhtml"')))
      : value)
    const result = await normalizeEpubEntries(nested, async () => 'sha256/x' as const)
    expect(result.blocks.find(block => block.page === 1)?.sourceLocator).toMatchObject({ href: '../OEBPS/text/ch1.xhtml', spineIndex: 0 })
    const external = fixture().map(value => value.name === 'OEBPS/content.opf'
      ? entry(value.name, bytes(new TextDecoder().decode(value.data).replace('href="text/ch1.xhtml"', 'href="https://evil.test/ch.xhtml"')))
      : value)
    await expect(normalizeEpubEntries(external, async () => 'sha256/x' as const)).rejects.toMatchObject({ code: 'EPUB_MANIFEST_INVALID' })
  })
})

describe('EPUB XHTML projection', () => {
  it('removes script/style and ignores data/remote images', () => {
    const blocks = parseXhtmlBlocks(
      '<html><body><style>.x{}</style><script>bad()</script><p>A&nbsp;B</p><img src="data:image/png;base64,AA" alt="inline"/></body></html>',
      'OPS/ch.xhtml', 3, '第三章',
    )
    expect(blocks[0]?.type).toBe('title')
    expect(blocks.some(block => block.text === 'A B')).toBe(true)
    expect(blocks.some(block => block.type === 'image')).toBe(false)
    expect(decodeEntities('A&#x2014;B&amp;C')).toBe('A—B&C')
  })

  it('extracts Calibre leaf div paragraphs and inferred section headings', () => {
    const blocks = parseXhtmlBlocks(`
      <html><body>
        <div class="calibre4">
          <div class="niv1tit">§ 15. <span>— Réduire la réciprocité</span></div>
          <div class="fmp">Un chemin se referme, <span>mais le texte continue</span>.</div>
          <div class="fmp">Deuxième paragraphe<br/>avec une nouvelle ligne.</div>
        </div>
      </body></html>
    `, 'text/part0009.html', 11, "DE L'AMANT")

    expect(blocks).toEqual([
      expect.objectContaining({ type: 'title', text: '§ 15. — Réduire la réciprocité', headingLevel: 1 }),
      expect.objectContaining({ type: 'paragraph', text: 'Un chemin se referme, mais le texte continue.' }),
      expect.objectContaining({ type: 'paragraph', text: 'Deuxième paragraphe\navec une nouvelle ligne.' }),
    ])
  })

  it('keeps structured list, table, quote, footnote, code and image locations', () => {
    const blocks = parseXhtmlBlocks(`
      <html><body><h1>章</h1>
        <ol><li>第一项</li><li>第二项<ul><li>嵌套项</li></ul></li></ol>
        <blockquote>引用文字</blockquote>
        <aside epub:type="footnote">脚注文字</aside>
        <pre>const x = 1;\nreturn x;</pre>
        <table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>
        <img src="../img/a.png" alt="图 A"/>
      </body></html>
    `, 'OPS/text/ch.xhtml', 4, '第四章', 'text/ch.xhtml')

    expect(blocks.find(block => block.type === 'list')?.text).toBe('1. 第一项\n2. 第二项')
    expect(blocks.find(block => block.type === 'other')?.text).toBe('引用文字')
    expect(blocks.find(block => block.type === 'footnote')?.text).toBe('脚注文字')
    expect(blocks.find(block => block.type === 'code')?.text).toContain('return x;')
    expect(blocks.find(block => block.type === 'table')?.text).toBe('名称 | 值\nA | 1')
    expect(blocks.find(block => block.type === 'image')?.sourceLocator).toMatchObject({ href: 'text/ch.xhtml', spineIndex: 3 })
  })
})
