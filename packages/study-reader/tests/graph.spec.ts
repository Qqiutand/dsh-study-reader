/**
 * Argument-graph validation tests: duplicate nodes/edges, dangling edges,
 * confidence bounds, citation source/revision consistency, block/page
 * matching, quote substring checks, and configured size caps.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ArgumentGraph, BlockId, RevisionId, SourceId } from '../lib/types/study/types.js'
import { disposeHarnesses, eventually, pdfFixture, setupStudy, type StudyHarness } from './helpers.ts'

const harnesses: StudyHarness[] = []

async function setup(): Promise<StudyHarness> {
  const value = await setupStudy({ maxGraphNodes: 10, maxGraphEdges: 20 })
  harnesses.push(value)
  return value
}

afterEach(async () => {
  await disposeHarnesses()
  harnesses.splice(0)
})

/** Import a fixture document into the given harness and return its ids. */
async function readyRevision(harness: StudyHarness): Promise<{
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  readonly blockId: BlockId
  readonly page: number
  readonly text: string
}> {
  harness.server.mode = { pollSequence: ['done'] }
  const { ctx } = harness
  const pdf = await pdfFixture()
  const prepared = await ctx.study.prepareUploadForClient({ fileName: 'theory.pdf', sizeBytes: pdf.byteLength })
  await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
    method: 'PUT',
    headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
    body: Buffer.from(pdf),
  })
  await eventually(() => ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
  const source = ctx.study.listSources()[0]
  if (source?.revisionId === undefined) throw new Error('revision missing')
  const read = await ctx.study.read({
    sourceId: source.id,
    revisionId: source.revisionId,
    range: { kind: 'blocks', start: 0, end: 100 },
  }, 100000)
  const block = read.blocks.find(candidate => candidate.text === '社会科学的核心问题是解释社会现象。')
    ?? read.blocks[1]
  if (block === undefined) throw new Error('no blocks')
  return {
    sourceId: source.id,
    revisionId: source.revisionId,
    blockId: block.id,
    page: block.page,
    text: block.text,
  }
}

function graphWith(anchor: { readonly sourceId: SourceId; readonly revisionId: RevisionId; readonly blockId: BlockId; readonly page: number; readonly text: string }): ArgumentGraph {
  return {
    schemaVersion: 1,
    title: '测试图谱',
    nodes: [
      {
        id: 'n1',
        type: 'claim',
        label: '核心主张',
        explanation: '解释',
        epistemic: 'author-explicit',
        confidence: 0.9,
        citations: [{
          sourceId: anchor.sourceId,
          revisionId: anchor.revisionId,
          blockId: anchor.blockId,
          page: anchor.page,
          quote: anchor.text.slice(0, 8),
        }],
      },
      {
        id: 'n2',
        type: 'premise',
        label: '前提',
        explanation: '前提',
        epistemic: 'ai-inference',
        confidence: 0.6,
        citations: [],
      },
    ],
    edges: [{ id: 'e1', from: 'n2', to: 'n1', type: 'supports' }],
  }
}

describe('publishArgumentGraph', () => {
  it('persists a valid graph and returns the artifact summary', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const result = await ctx.study.publishArgumentGraph(graphWith(anchor))
    expect(result.artifactId).toMatch(/^art-/)
    expect(result.nodeCount).toBe(2)
    expect(result.edgeCount).toBe(1)
    expect(result.graph.title).toBe('测试图谱')
  })

  it('rejects duplicate node ids', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    graph.nodes = [graph.nodes[0]!, graph.nodes[0]!]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_DUPLICATE_NODE_ID' })
  })

  it('rejects dangling edges', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    graph.edges = [{ id: 'e1', from: 'n2', to: 'missing', type: 'supports' }]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_DANGLING_EDGE' })
  })

  it('rejects confidence outside [0, 1]', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    graph.nodes = [{ ...graph.nodes[0]!, confidence: 1.2, citations: [] }, graph.nodes[1]!]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_CONFIDENCE_OUT_OF_RANGE' })
  })

  it('rejects citations spanning different sources or revisions', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    const node = graph.nodes[0]!
    graph.nodes = [{
      ...node,
      citations: [
        { sourceId: anchor.sourceId, revisionId: anchor.revisionId, blockId: anchor.blockId, page: anchor.page },
        { sourceId: 'src-other' as SourceId, revisionId: anchor.revisionId, blockId: anchor.blockId, page: anchor.page },
      ],
    }, graph.nodes[1]!]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_CITATION_MISMATCH' })
  })

  it('rejects a citation whose page does not match the block', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    const node = graph.nodes[0]!
    graph.nodes = [{
      ...node,
      citations: [{ sourceId: anchor.sourceId, revisionId: anchor.revisionId, blockId: anchor.blockId, page: anchor.page + 5 }],
    }, graph.nodes[1]!]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_PAGE_MISMATCH' })
  })

  it('rejects a quote that is not a normalized substring of the block text', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    const node = graph.nodes[0]!
    graph.nodes = [{
      ...node,
      citations: [{
        sourceId: anchor.sourceId,
        revisionId: anchor.revisionId,
        blockId: anchor.blockId,
        page: anchor.page,
        quote: '这段话根本不存在于原文中',
      }],
    }, graph.nodes[1]!]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_QUOTE_MISMATCH' })
  })

  it('accepts whitespace-normalized quotes', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const read = await ctx.study.read({
      sourceId: anchor.sourceId,
      revisionId: anchor.revisionId,
      range: { kind: 'blocks', start: 0, end: 100 },
    }, 100000)
    const table = read.blocks.find(block => block.text.includes(' | '))
    if (table === undefined) throw new Error('table block missing')
    const graph = graphWith(anchor)
    const node = graph.nodes[0]!
    graph.nodes = [{
      ...node,
      citations: [{
        sourceId: anchor.sourceId,
        revisionId: anchor.revisionId,
        blockId: table.id,
        page: table.page,
        // Extra whitespace inside an existing space collapses to the block text.
        quote: '方法   |\t 适用场景',
      }],
    }, graph.nodes[1]!]
    const result = await ctx.study.publishArgumentGraph(graph)
    expect(result.nodeCount).toBe(2)
  })

  it('rejects graphs over the configured caps', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    const extra = Array.from({ length: 10 }, (_, index) => ({
      id: `x${index}`,
      type: 'premise' as const,
      label: `x${index}`,
      explanation: '',
      epistemic: 'ai-inference' as const,
      confidence: 0.5,
      citations: [],
    }))
    graph.nodes = [...graph.nodes, ...extra]
    await expect(ctx.study.publishArgumentGraph(graph)).rejects.toMatchObject({ code: 'GRAPH_TOO_LARGE' })
  })

  it('rejects malformed graphs at the schema boundary', async () => {
    const harness = await setup()
    const anchor = await readyRevision(harness)
    const ctx = harness.ctx
    const graph = graphWith(anchor)
    await expect(ctx.study.publishArgumentGraph({ ...graph, schemaVersion: 2 })).rejects
      .toMatchObject({ code: 'GRAPH_INVALID' })
  })
})
