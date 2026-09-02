import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses, eventually, pdfFixture, setupStudy, type StudyHarness } from './helpers.ts'

async function importReadySource(harness: StudyHarness, fileName: string) {
  const existingIds = new Set(harness.ctx.study.listSources().map(source => source.id))
  harness.server.mode = { pollSequence: ['done'] }
  const pdf = await pdfFixture()
  const prepared = await harness.ctx.study.prepareUploadForClient({ fileName, sizeBytes: pdf.byteLength })
  const upload = await fetch(`http://127.0.0.1:${String(harness.ctx.webServer.port)}${prepared.uploadPath}`, {
    method: 'PUT',
    headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
    body: Buffer.from(pdf),
  })
  expect(upload.status).toBe(200)
  await eventually(() => harness.ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
  return harness.ctx.study.listSources().find(source => !existingIds.has(source.id))!
}

interface RpcResult {
  readonly response: Response
  readonly body: Record<string, unknown>
  readonly text: string
}

async function rpc(harness: StudyHarness, token: string | undefined, id: number, method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const response = await fetch(`http://127.0.0.1:${String(harness.ctx.webServer.port)}/study-reader/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await response.text()
  const payload = response.headers.get('content-type')?.includes('text/event-stream') === true
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).at(-1)
    : text
  const body = payload === undefined || payload === '' || response.headers.get('content-type')?.includes('text/plain') === true
    ? {}
    : JSON.parse(payload) as Record<string, unknown>
  return { response, body, text }
}

function rpcResult(value: RpcResult): Record<string, unknown> {
  expect(value.response.status).toBe(200)
  expect(value.body).not.toHaveProperty('error')
  return value.body.result as Record<string, unknown>
}

afterEach(async () => await disposeHarnesses())

describe('embedded external MCP', () => {
  it('exposes only fixed-scope Reader tools and rejects the token immediately after revocation', async () => {
    const harness = await setupStudy()
    const source = await importReadySource(harness, 'granted-evidence.pdf')
    const hiddenSource = await importReadySource(harness, 'hidden-evidence.pdf')
    const created = await harness.ctx.study.createExternalAccessForClient({
      sessionId: 'mcp-test',
      commandId: 'create-mcp-test',
      label: 'Codex test',
      mcpServerName: 'reader-probability',
      readingSetLabel: 'Probability',
      sourceIds: [source.id],
      expiresInDays: 7,
    })
    expect(created.codexConfig).toContain('[mcp_servers.reader-probability]')
    expect(created.codexConfig).toContain(`bearer_token_env_var = "${created.environmentVariable}"`)
    expect(created.environmentVariable).toBe('DSH_STUDY_READER_PROBABILITY_TOKEN')

    const unauthorized = await rpc(harness, undefined, 1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    })
    expect(unauthorized.response.status).toBe(401)
    expect(unauthorized.response.headers.get('www-authenticate')).toBe('Bearer')

    const initialized = rpcResult(await rpc(harness, created.token, 2, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    }))
    expect(initialized.instructions).toContain('Reader connection reader-probability')
    expect(initialized.instructions).toContain('reader_list_sets')
    expect(initialized.instructions).toContain('no per-turn or per-session Reader call-count budget')
    const listed = rpcResult(await rpc(harness, created.token, 3, 'tools/list'))
    expect((listed.tools as readonly { readonly name: string }[]).map(tool => tool.name)).toEqual([
      'reader_list_sets', 'reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages', 'reader_read_passage',
    ])
    expect((listed.tools as readonly { readonly name: string }[]).some(tool => tool.name === 'reader_save_note')).toBe(false)

    const initialSetRef = created.connection.readingSets[0]!.setRef
    const context = rpcResult(await rpc(harness, created.token, 4, 'tools/call', { name: 'reader_get_context', arguments: {} }))
    const contextData = (context.structuredContent as { readonly data: { readonly library: { readonly documents: readonly { readonly documentRef: string }[] } } }).data
    const documentRef = contextData.library.documents[0]!.documentRef
    expect(contextData.library.documents).toHaveLength(1)
    expect(documentRef).toMatch(/^doc_\d+$/u)
    expect(JSON.stringify(context)).not.toContain(String(source.id))
    expect(JSON.stringify(context)).not.toContain(hiddenSource.title)

    const updatedConnection = await harness.ctx.study.saveExternalReadingSetForClient({
      sessionId: 'mcp-test',
      commandId: 'add-hidden-set',
      accessId: created.connection.id,
      expectedVersion: created.connection.version,
      label: 'Other evidence',
      sourceIds: [hiddenSource.id],
    })
    const otherSetRef = updatedConnection.readingSets.find(set => set.label === 'Other evidence')!.setRef
    const setsResult = rpcResult(await rpc(harness, created.token, 40, 'tools/call', { name: 'reader_list_sets', arguments: {} }))
    expect(setsResult.structuredContent).toMatchObject({ status: 'success', data: { sets: [
      { setRef: initialSetRef, name: 'Probability', documentCount: 1 },
      { setRef: otherSetRef, name: 'Other evidence', documentCount: 1 },
    ] } })
    const missingSet = rpcResult(await rpc(harness, created.token, 41, 'tools/call', { name: 'reader_get_context', arguments: {} }))
    expect(missingSet.structuredContent).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } })

    const hidden = rpcResult(await rpc(harness, created.token, 5, 'tools/call', {
      name: 'reader_get_outline',
      arguments: { setRef: initialSetRef, document: { kind: 'document_title', title: hiddenSource.title } },
    }))
    expect(hidden.structuredContent).toMatchObject({ status: 'error', error: { code: 'DOCUMENT_NOT_FOUND' } })

    const otherContext = rpcResult(await rpc(harness, created.token, 42, 'tools/call', { name: 'reader_get_context', arguments: { setRef: otherSetRef } }))
    expect(JSON.stringify(otherContext)).toContain(hiddenSource.title)
    expect(JSON.stringify(otherContext)).not.toContain(source.title)
    const otherDocumentRef = ((otherContext.structuredContent as { readonly data: { readonly library: { readonly documents: readonly { readonly documentRef: string }[] } } }).data.library.documents[0]!).documentRef

    const searched = rpcResult(await rpc(harness, created.token, 6, 'tools/call', {
      name: 'reader_search_passages',
      arguments: { setRef: initialSetRef, query: '核心问题', scope: { kind: 'document_ref', documentRef }, limit: 3 },
    }))
    const searchData = (searched.structuredContent as { readonly data: { readonly results: readonly { readonly passageRef: string }[] } }).data
    expect(searchData.results[0]?.passageRef).toMatch(/^passage_\d+$/u)

    const read = rpcResult(await rpc(harness, created.token, 7, 'tools/call', {
      name: 'reader_read_passage',
      arguments: { setRef: initialSetRef, target: { kind: 'passage_ref', passageRef: searchData.results[0]!.passageRef }, window: 1 },
    }))
    expect(JSON.stringify(read)).toContain('社会科学的核心问题')

    const crossedDocument = rpcResult(await rpc(harness, created.token, 43, 'tools/call', {
      name: 'reader_get_outline',
      arguments: { setRef: initialSetRef, document: { kind: 'document_ref', documentRef: otherDocumentRef } },
    }))
    expect(crossedDocument.structuredContent).toMatchObject({ status: 'error', error: { code: 'PERMISSION_DENIED' } })

    const crossedPassage = rpcResult(await rpc(harness, created.token, 44, 'tools/call', {
      name: 'reader_read_passage',
      arguments: { setRef: otherSetRef, target: { kind: 'passage_ref', passageRef: searchData.results[0]!.passageRef }, window: 1 },
    }))
    expect(crossedPassage.structuredContent).toMatchObject({ status: 'error', error: { code: 'PERMISSION_DENIED' } })

    // This deliberately exceeds the ordinary DSH Reader discovery budget.
    // External MCP grants do not maintain a call-count budget.
    for (let index = 0; index < 20; index += 1) {
      const repeated = rpcResult(await rpc(harness, created.token, 60 + index, 'tools/call', { name: 'reader_get_context', arguments: { setRef: initialSetRef } }))
      expect(repeated.structuredContent).toMatchObject({ status: 'success' })
      expect(JSON.stringify(repeated)).not.toContain('CALL_BUDGET_EXCEEDED')
    }

    await harness.ctx.study.revokeExternalAccessForClient({
      sessionId: 'mcp-test',
      commandId: 'revoke-mcp-test',
      accessId: created.connection.id,
      expectedVersion: updatedConnection.version,
    })
    const revoked = await rpc(harness, created.token, 8, 'tools/list')
    expect(revoked.response.status).toBe(401)
  })
})
