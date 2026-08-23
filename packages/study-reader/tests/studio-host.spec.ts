import { afterEach, describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { disposeHarnesses, setupStudy } from './helpers.ts'

afterEach(async () => { await disposeHarnesses() })

describe('Study injection Studio Host remotes', () => {
  it('pages typed tree children and asset rows without returning the whole repository snapshot', async () => {
    const harness = await setupStudy()
    const study = harness.ctx.study
    const firstFolder = await study.executeStudioCommandForClient({ sessionId: 'studio-session', commandId: 'tree-a', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'create-folder', namespace: 'prompt', name: 'A' } } })
    await study.executeStudioCommandForClient({ sessionId: 'studio-session', commandId: 'tree-b', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'create-folder', namespace: 'prompt', name: 'B' } } })
    const firstPage = await study.listTreeChildrenForClient({ sessionId: 'studio-session', namespace: 'prompt', limit: 1 })
    expect(firstPage).toMatchObject({ total: 2, folders: [{ name: 'A', namespace: 'prompt' }], nextCursor: '1' })
    expect((await study.listTreeChildrenForClient({ sessionId: 'studio-session', namespace: 'prompt', cursor: firstPage.nextCursor, limit: 1 })).folders[0]?.name).toBe('B')
    const prompt = await study.executeStudioCommandForClient({ sessionId: 'studio-session', commandId: 'tree-prompt', command: { kind: 'create-prompt', folderId: firstFolder.folder!.id, name: 'Paged prompt', description: 'detail', layer: 'system-addon', priority: 1, content: 'Evidence.' } })
    const assets = await study.listAssetsForClient({ sessionId: 'studio-session', namespace: 'prompt', folderId: firstFolder.folder!.id, limit: 1 })
    expect(assets).toMatchObject({ total: 1, assets: [{ id: prompt.prompt!.id, kind: 'prompt', name: 'Paged prompt' }] })
    const browserIndex = await study.studioSnapshotForClient({ sessionId: 'studio-session' })
    expect(browserIndex.prompts).toContainEqual(expect.objectContaining({ id: prompt.prompt!.id, currentVersion: 1 }))
    expect(browserIndex.prompts[0]).not.toHaveProperty('revisions')
    expect(JSON.stringify(browserIndex)).not.toContain('Evidence.')
    expect(await study.getAssetDetailForClient({ sessionId: 'studio-session', kind: 'prompt', assetId: prompt.prompt!.id })).toMatchObject({ kind: 'prompt', value: { currentVersion: 1 } })
  })

  it('routes managed Skill folders and moves through the unified asset-tree command', async () => {
    const harness = await setupStudy()
    const study = harness.ctx.study
    const folder = await study.executeStudioCommandForClient({ sessionId: 'studio-session', commandId: 'skill-tree-folder', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'create-folder', namespace: 'skill', name: 'Proof skills' } } })
    expect(folder.accepted).toBe(true)
    const tree = await study.listTreeChildrenForClient({ sessionId: 'studio-session', namespace: 'skill' })
    const folderId = tree.folders.find(candidate => candidate.name === 'Proof skills')!.id
    const created = await study.executeSkillCommandForClient({ sessionId: 'studio-session', commandId: 'skill-tree-create', command: { kind: 'create-skill', name: 'Proof helper', description: '', instructions: 'Use evidence.' } })
    const asset = (await study.listAssetsForClient({ sessionId: 'studio-session', namespace: 'skill' })).assets.find(candidate => candidate.id === created.skill!.id)!
    await study.executeStudioCommandForClient({ sessionId: 'studio-session', commandId: 'skill-tree-move', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'move-asset', namespace: 'skill', assetId: asset.id, folderId, expectedVersion: asset.recordVersion } } })
    expect(await study.getAssetDetailForClient({ sessionId: 'studio-session', kind: 'skill', assetId: asset.id })).toMatchObject({ kind: 'skill', value: { folderId } })
  })

  it('persists and applies non-secret MinerU configuration while returning only credential status metadata', async () => {
    const harness = await setupStudy()
    const study = harness.ctx.study
    const [before] = await study.listProviderConnectionsForClient({ sessionId: 'studio-session' })
    expect(before).toMatchObject({ providerId: 'mineru', enabled: true, version: 1, credentialRef: 'MINERU_API_KEY' })
    const saved = await study.saveProviderConnectionForClient({
      sessionId: 'studio-session', commandId: 'provider-save-v2', providerId: 'mineru', connectionId: before!.id, displayName: before!.displayName, expectedVersion: 1, activate: true,
      endpoint: before!.endpoint, enabled: true, model: 'pipeline', nonSecretConfig: { ...before!.options, language: 'en', requestTimeoutMs: 4321 },
    })
    expect(saved).toMatchObject({ version: 2, model: 'pipeline', nonSecretConfig: { language: 'en', requestTimeoutMs: 4321 } })
    expect(harness.ctx.documentExtraction.connection()).toMatchObject({ model: 'pipeline', options: { language: 'en', requestTimeoutMs: 4321 } })
    expect(await study.testProviderConnectionForClient({ sessionId: 'studio-session', providerId: 'mineru' })).toMatchObject({ ok: true, providerStatus: 'available' })
    expect(JSON.stringify(await study.listProviderConnectionsForClient({ sessionId: 'studio-session' }))).not.toContain('test-key')
    await expect(study.saveProviderConnectionForClient({
      sessionId: 'studio-session', commandId: 'provider-stale', providerId: 'mineru', connectionId: before!.id, displayName: before!.displayName, expectedVersion: 1, activate: true,
      endpoint: before!.endpoint, enabled: true, model: 'vlm', nonSecretConfig: before!.options,
    })).rejects.toMatchObject({ code: 'PROVIDER_CONNECTION_VERSION_CONFLICT' })
  })

  it('restores non-secret Provider configuration without persisting credential values', async () => {
    const first = await setupStudy()
    const before = (await first.ctx.study.listProviderConnectionsForClient({ sessionId: 'restart-session' }))[0]!
    await first.ctx.study.saveProviderConnectionForClient({
      sessionId: 'restart-session', commandId: 'provider-restart-v2', providerId: 'mineru', connectionId: before.id, displayName: before.displayName, expectedVersion: before.version, activate: true,
      endpoint: before.endpoint, enabled: true, model: 'pipeline', nonSecretConfig: { ...before.options, language: 'german', requestTimeoutMs: 3456 },
    })
    const root = first.root
    await first.dispose(false)
    const restarted = await setupStudy({}, {}, root)
    const restored = (await restarted.ctx.study.listProviderConnectionsForClient({ sessionId: 'restart-session' }))[0]!
    expect(restored).toMatchObject({ version: 2, model: 'pipeline', options: { language: 'german', requestTimeoutMs: 3456 }, credentialRef: 'MINERU_API_KEY' })
    const files = await textFiles(root)
    expect((await Promise.all(files.map(async file => await readFile(file, 'utf8')))).join('\n')).not.toContain('test-key')
  })

  it('persists version-pinned Profiles and compiles the immutable baseline without browser state', async () => {
    const harness = await setupStudy()
    const study = harness.ctx.study
    const prompt = await study.executeStudioCommandForClient({
      sessionId: 'studio-session', commandId: 'studio-create-prompt',
      command: { kind: 'create-prompt', name: 'Evidence', description: 'Ground answers.', layer: 'system-addon', priority: 10, content: 'Use reader_search_passages before unsupported claims.' },
    })
    const profile = await study.executeStudioCommandForClient({
      sessionId: 'studio-session', commandId: 'studio-create-profile',
      command: {
        kind: 'create-profile', name: 'Default reading', description: '',
        promptBindings: [{ promptId: prompt.prompt!.id, promptVersion: 1, enabled: true, order: 0 }],
        skillBindings: [{ skillId: 'trace-argument', skillVersion: 1, enabled: true, invocation: 'both' }],
        toolPolicies: [{ toolName: 'reader_get_outline', enabled: true }, { toolName: 'reader_search_passages', enabled: true }, { toolName: 'reader_read_passage', enabled: true }],
        modelPolicy: { kind: 'inherit-session' },
      },
    })
    const preview = await study.compileInjectionProfileForClient({ sessionId: 'studio-session', profileId: profile.profile!.id, profileVersion: 1 })
    expect(preview.systemText).toContain('untrusted evidence data')
    expect(preview.systemText).toContain('reader_search_passages')
    expect(preview.manifest.profile).toEqual({ id: profile.profile!.id, version: 1 })
    expect(preview.manifest.skills).toEqual([{ id: 'trace-argument', version: 1, invocation: 'both' }])
    expect(preview.manifest).not.toHaveProperty('selectedSource')
    expect(preview.manifest.promptFragments[0]).toMatchObject({ id: 'study-reader:immutable-baseline', version: 1, layer: 'immutable-system' })

    const activated = await study.executeStudioCommandForClient({
      sessionId: 'studio-session', commandId: 'studio-activate-v1',
      command: { kind: 'activate-profile', profileId: profile.profile!.id, profileVersion: 1, expectedBindingVersion: 0 },
    })
    expect(activated.binding).toMatchObject({ profileVersion: 1, recordVersion: 1 })
    await study.executeStudioCommandForClient({
      sessionId: 'studio-session', commandId: 'studio-revise-profile',
      command: {
        kind: 'revise-profile', profileId: profile.profile!.id, expectedRecordVersion: 1, name: 'Default reading', description: 'v2',
        promptBindings: [{ promptId: prompt.prompt!.id, promptVersion: 1, enabled: true, order: 0 }],
        skillBindings: [{ skillId: 'trace-argument', skillVersion: 1, enabled: true, invocation: 'both' }],
        toolPolicies: [{ toolName: 'reader_get_outline', enabled: true }, { toolName: 'reader_search_passages', enabled: true }, { toolName: 'reader_read_passage', enabled: true }],
        modelPolicy: { kind: 'inherit-session' },
      },
    })
    const pinned = await study.compileInjectionProfileForClient({ sessionId: 'studio-session' })
    expect(pinned.manifest.profile.version).toBe(1)
    expect((await study.studioSnapshotForClient({ sessionId: 'studio-session' })).binding?.profileVersion).toBe(1)
    expect((await study.studioSnapshotForClient({ sessionId: 'studio-session' })).skills.filter(skill => skill.id === 'trace-argument')).toHaveLength(1)
    expect(study.listToolCatalogForClient({ sessionId: 'studio-session' }).filter(tool => tool.enabledInCurrentProfile).map(tool => tool.name)).toEqual(['reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages', 'reader_read_passage'])

    harness.ctx.systemPrompt.tools(() => ({ schemas: [
      { name: 'reader_search_passages', description: 'search', parameters: { type: 'object' } },
      { name: 'reader_read_passage', description: 'read', parameters: { type: 'object' } },
      { name: 'web_search', description: 'web', parameters: { type: 'object' } },
    ] }))
    const runtime = await harness.agents.runAs('studio-session', async () => await harness.ctx.systemPrompt.assemble())
    // An initiator id without a live Agent turn cannot receive dynamic Reader
    // context, Profile text, or Reader schemas.
    expect(runtime.sections.find(section => section.name === 'study:injection-profile')).toBeUndefined()
    expect(runtime.tools.map(tool => tool.name)).toEqual(['web_search'])
  })
})

async function textFiles(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await textFiles(path))
    else if (entry.isFile() && /\.(?:json|jsonl|txt)$/u.test(entry.name)) output.push(path)
  }
  return output
}
