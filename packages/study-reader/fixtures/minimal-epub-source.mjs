/**
 * Public-domain, deliberately small EPUB 3 source used by the import fixture.
 * Entry order is part of the fixture protocol: EPUB requires `mimetype` first.
 */
export const EPUB_MIMETYPE = 'application/epub+zip'

/** A fixed DOS-compatible timestamp for reproducible ZIP metadata. */
export const EPUB_FIXTURE_MTIME = new Date('2000-01-01T00:00:00.000Z')

/**
 * Ordered EPUB resources. The first entry must be stored, never deflated.
 * @returns {readonly { name: string, text: string, compress: boolean }[]} source entries
 */
export function minimalEpubEntries() {
  return [
    { name: 'mimetype', text: EPUB_MIMETYPE, compress: false },
    { name: 'META-INF/container.xml', text: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`, compress: true },
    { name: 'OEBPS/content.opf', text: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:3f3ae3fe-65ac-4c82-a64d-c0632632d7e1</dc:identifier>
    <dc:title>本地 EPUB 导入小册 / Local EPUB Import Primer</dc:title>
    <dc:creator>开放测试作者 Open Test Author</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter-one" href="text/chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-two" href="text/chapter-2.xhtml" media-type="application/xhtml+xml"/>
    <item id="diagram" href="images/diagram.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="chapter-one"/><itemref idref="chapter-two"/></spine>
</package>
`, compress: true },
    { name: 'OEBPS/nav.xhtml', text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>目录</title></head><body>
  <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>
    <li><a href="text/chapter-1.xhtml#chapter-one">第一章：起点 / Beginnings</a></li>
    <li><a href="text/chapter-2.xhtml#chapter-two">第二章：验证 / Verification</a></li>
  </ol></nav>
</body></html>
`, compress: true },
    { name: 'OEBPS/text/chapter-1.xhtml', text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>第一章</title></head><body>
  <h1 id="chapter-one">第一章：起点 / Beginnings</h1>
  <p>这是第一段中文正文。它与 English prose 一起验证 Unicode 内容不会在导入中丢失。</p>
  <p>这是第二段正文，跨越独立段落，并指向<a href="#note-one">脚注一</a>。</p>
  <figure><img src="../images/diagram.png" alt="红色测试图示"/><figcaption>结构化图片预览</figcaption></figure>
  <h2>一个简单公式 / A Small Formula</h2>
  <math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>
  <aside id="note-one" epub:type="footnote" xmlns:epub="http://www.idpf.org/2007/ops"><p>脚注一：内部锚点仍留在本章 XHTML 中。</p></aside>
</body></html>
`, compress: true },
    { name: 'OEBPS/text/chapter-2.xhtml', text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>Chapter Two</title></head><body>
  <h1 id="chapter-two">第二章：验证 / Verification</h1>
  <p>第二章的精确检索句：the lantern protocol preserves chapter order.</p>
  <p>中文收束段落：本地解析器应直接完成导入，而无需远程提取服务。</p>
</body></html>
`, compress: true },
    { name: 'OEBPS/images/diagram.png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAfN5NwAAAABJRU5ErkJggg==', compress: true },
  ]
}
