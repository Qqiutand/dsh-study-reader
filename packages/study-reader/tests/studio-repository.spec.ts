import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { IMMUTABLE_BASELINE_PROMPT_ID, InjectionStudioRepository } from '../src/studio/repository.ts'
import type { AssetFolderRecord, InjectionProfileRecord, InjectionStudioCommandReceipt, PromptAssetRecord, SessionInjectionBinding } from '../src/studio/types.ts'

class Table<V> implements KvTable<string, V> {
  private readonly rows = new Map<string, V>()
  get(key: string): V | undefined { return this.rows.get(key) }
  entries(): IterableIterator<[string, V]> { return this.rows.entries() }
  keys(): IterableIterator<string> { return this.rows.keys() }
  get size(): number { return this.rows.size }
  async put(key: string, value: V): Promise<void> { this.rows.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.rows.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.rows.get(key)
    if (current === undefined) throw new Error('missing row')
    const next = fn(current); this.rows.set(key, next); return next
  }
}

function repository() {
  let now = 100
  const prompts = new Table<PromptAssetRecord>()
  const profiles = new Table<InjectionProfileRecord>()
  const bindings = new Table<SessionInjectionBinding>()
  const receipts = new Table<InjectionStudioCommandReceipt>()
  const folders = new Table<AssetFolderRecord>()
  return { prompts, profiles, bindings, receipts, folders, repository: new InjectionStudioRepository({ prompts, profiles, bindings, receipts, folders, now: () => ++now }) }
}

describe('InjectionStudioRepository', () => {
  it('persists one immutable baseline and rejects every attempted mutation or binding override', async () => {
    const state = repository()
    const first = await state.repository.snapshot('session-1')
    const second = await state.repository.snapshot('session-1')
    expect(first.immutableBaseline).toEqual(second.immutableBaseline)
    expect(first.immutableBaseline).toMatchObject({ id: IMMUTABLE_BASELINE_PROMPT_ID, source: 'builtin', readonly: true, archived: false, currentVersion: 1 })
    expect(state.prompts.size).toBe(1)
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'revise-baseline', command: { kind: 'revise-prompt', promptId: IMMUTABLE_BASELINE_PROMPT_ID, expectedRecordVersion: 1, name: 'x', description: '', layer: 'system-addon', priority: 0, content: 'changed' } }))
      .rejects.toMatchObject({ code: 'INJECTION_BASELINE_READ_ONLY' })
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'bind-baseline', command: { kind: 'create-profile', name: 'Bad', description: '', promptBindings: [{ promptId: IMMUTABLE_BASELINE_PROMPT_ID, promptVersion: 1, enabled: false, order: 0 }], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } }))
      .rejects.toMatchObject({ code: 'INJECTION_BASELINE_BINDING_FORBIDDEN' })
  })

  it('appends immutable Prompt/Profile revisions, enforces CAS, and replays command results', async () => {
    const state = repository()
    const created = await state.repository.execute({ sessionId: 'session-1', commandId: 'create-prompt-1', command: { kind: 'create-prompt', name: 'Evidence', description: '', layer: 'system-addon', priority: 10, content: 'Use bounded evidence.' } })
    const replay = await state.repository.execute({ sessionId: 'session-1', commandId: 'create-prompt-1', command: { kind: 'create-prompt', name: 'Evidence', description: '', layer: 'system-addon', priority: 10, content: 'Use bounded evidence.' } })
    expect(replay).toEqual(created)
    const revised = await state.repository.execute({ sessionId: 'session-1', commandId: 'revise-prompt-1', command: { kind: 'revise-prompt', promptId: created.prompt!.id, expectedRecordVersion: 1, name: 'Evidence', description: 'v2', layer: 'system-addon', priority: 10, content: 'Use exact bounded evidence.' } })
    expect(revised.prompt?.revisions.map(value => value.version)).toEqual([1, 2])
    expect(revised.prompt?.revisions[0]).toEqual(created.prompt?.revisions[0])
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'stale-prompt', command: { kind: 'revise-prompt', promptId: created.prompt!.id, expectedRecordVersion: 1, name: 'Evidence', description: '', layer: 'system-addon', priority: 10, content: 'stale' } }))
      .rejects.toMatchObject({ code: 'INJECTION_PROMPT_VERSION_CONFLICT' })

    const profile = await state.repository.execute({ sessionId: 'session-1', commandId: 'create-profile-1', command: { kind: 'create-profile', name: 'Reading', description: '', promptBindings: [{ promptId: created.prompt!.id, promptVersion: 1, enabled: true, order: 0 }], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } })
    const profileV2 = await state.repository.execute({ sessionId: 'session-1', commandId: 'revise-profile-1', command: { kind: 'revise-profile', profileId: profile.profile!.id, expectedRecordVersion: 1, name: 'Reading', description: 'v2', promptBindings: [{ promptId: created.prompt!.id, promptVersion: 2, enabled: true, order: 0 }], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } })
    expect(profileV2.profile?.revisions.map(value => value.version)).toEqual([1, 2])
    const bound = await state.repository.execute({ sessionId: 'session-1', commandId: 'activate-profile-v1', command: { kind: 'activate-profile', profileId: profile.profile!.id, profileVersion: 1, expectedBindingVersion: 0 } })
    expect(bound.binding).toMatchObject({ profileVersion: 1, recordVersion: 1 })
    const cleared = await state.repository.execute({ sessionId: 'session-1', commandId: 'deactivate-profile-v1', command: { kind: 'deactivate-profile', expectedBindingVersion: 1 } })
    expect(cleared.bindingCleared).toBe(true)
    expect((await state.repository.snapshot('session-1')).binding).toBeUndefined()
  })

  it('rejects commandId reuse with different payload and keeps a stable rejected receipt', async () => {
    const state = repository()
    const request = { sessionId: 'session-1', commandId: 'bad-create', command: { kind: 'create-prompt' as const, name: '', description: '', layer: 'system-addon' as const, priority: 0, content: 'x' } }
    await expect(state.repository.execute(request)).rejects.toMatchObject({ code: 'INJECTION_ASSET_INVALID' })
    await expect(state.repository.execute(request)).rejects.toMatchObject({ code: 'INJECTION_ASSET_INVALID' })
    await expect(state.repository.execute({ ...request, command: { ...request.command, name: 'different' } })).rejects.toMatchObject({ code: 'INJECTION_COMMAND_ID_CONFLICT' })
    expect(state.receipts.get('bad-create')).toMatchObject({ state: 'rejected', errorCode: 'INJECTION_ASSET_INVALID' })
  })

  it('rejects a fixed model route instead of silently ignoring it', async () => {
    const state = repository()
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'fixed-model', command: { kind: 'create-profile', name: 'Fixed', description: '', promptBindings: [], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'fixed-provider', providerId: 'provider', modelId: 'model' } } }))
      .rejects.toMatchObject({ code: 'INJECTION_MODEL_POLICY_UNSUPPORTED' })
  })

  it('rejects duplicate capability bindings and oversized Tool guidance at the write boundary', async () => {
    const state = repository()
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'duplicate-tools', command: { kind: 'create-profile', name: 'Bad tools', description: '', promptBindings: [], skillBindings: [], toolPolicies: [{ toolName: 'reader_read_passage', enabled: true }, { toolName: 'reader_read_passage', enabled: false }], modelPolicy: { kind: 'inherit-session' } } })).rejects.toMatchObject({ code: 'INJECTION_TOOL_DUPLICATE' })
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'duplicate-skills', command: { kind: 'create-profile', name: 'Bad skills', description: '', promptBindings: [], skillBindings: [{ skillId: 'skill-1', skillVersion: 1, enabled: true, invocation: 'user' }, { skillId: 'skill-1', skillVersion: 1, enabled: true, invocation: 'model' }], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } })).rejects.toMatchObject({ code: 'INJECTION_SKILL_DUPLICATE' })
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'long-guidance', command: { kind: 'create-profile', name: 'Long guidance', description: '', promptBindings: [], skillBindings: [], toolPolicies: [{ toolName: 'reader_read_passage', enabled: true, guidanceAppendix: 'x'.repeat(4001) }], modelPolicy: { kind: 'inherit-session' } } })).rejects.toMatchObject({ code: 'INJECTION_TOOL_GUIDANCE_INVALID' })
  })

  it('permanently deletes archived user assets and removes profile references', async () => {
    const state = repository()
    const prompt = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-prompt-create', command: { kind: 'create-prompt', name: 'Temporary rule', description: '', layer: 'system-addon', priority: 0, content: 'Temporary.' } })
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'delete-prompt-active', command: { kind: 'delete-prompt', promptId: prompt.prompt!.id, expectedRecordVersion: 1 } })).rejects.toMatchObject({ code: 'INJECTION_PROMPT_DELETE_REQUIRES_ARCHIVE' })
    const referencingProfile = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-prompt-profile', command: { kind: 'create-profile', name: 'References prompt', description: '', promptBindings: [{ promptId: prompt.prompt!.id, promptVersion: 1, enabled: true, order: 0 }], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } })
    const archivedPrompt = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-prompt-archive', command: { kind: 'archive-prompt', promptId: prompt.prompt!.id, expectedRecordVersion: 1, archived: true } })
    const deletedPrompt = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-prompt-final', command: { kind: 'delete-prompt', promptId: prompt.prompt!.id, expectedRecordVersion: archivedPrompt.prompt!.recordVersion } })
    expect(deletedPrompt.promptDeleted).toBe(true)
    expect(state.prompts.get(prompt.prompt!.id)).toBeUndefined()
    expect(state.profiles.get(referencingProfile.profile!.id)?.revisions.flatMap(revision => revision.promptBindings)).toEqual([])

    const profile = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-profile-create', command: { kind: 'create-profile', name: 'Temporary plan', description: '', promptBindings: [], skillBindings: [], toolPolicies: [], modelPolicy: { kind: 'inherit-session' } } })
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'delete-profile-active', command: { kind: 'delete-profile', profileId: profile.profile!.id, expectedRecordVersion: 1 } })).rejects.toMatchObject({ code: 'INJECTION_PROFILE_DELETE_REQUIRES_ARCHIVE' })
    const archivedProfile = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-profile-archive', command: { kind: 'archive-profile', profileId: profile.profile!.id, expectedRecordVersion: 1, archived: true } })
    const deletedProfile = await state.repository.execute({ sessionId: 'session-1', commandId: 'delete-profile-final', command: { kind: 'delete-profile', profileId: profile.profile!.id, expectedRecordVersion: archivedProfile.profile!.recordVersion } })
    expect(deletedProfile.profileDeleted).toBe(true)
    expect(state.profiles.get(profile.profile!.id)).toBeUndefined()
  })

  it('persists typed folders and moves Prompt assets with record-version CAS', async () => {
    const state = repository()
    const prompt = await state.repository.execute({ sessionId: 'session-1', commandId: 'folder-prompt', command: { kind: 'create-prompt', name: 'Evidence', description: '', layer: 'system-addon', priority: 0, content: 'Use evidence.' } })
    const folder = await state.repository.execute({ sessionId: 'session-1', commandId: 'folder-create', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'create-folder', namespace: 'prompt', name: 'Methods' } } })
    const moved = await state.repository.execute({ sessionId: 'session-1', commandId: 'folder-move-prompt', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'move-asset', namespace: 'prompt', assetId: prompt.prompt!.id, folderId: folder.folder!.id, expectedVersion: 1 } } })
    expect(moved.prompt).toMatchObject({ folderId: folder.folder!.id, recordVersion: 2 })
    expect((await state.repository.snapshot('session-1')).folders).toEqual([folder.folder])
    await expect(state.repository.execute({ sessionId: 'session-1', commandId: 'folder-delete-nonempty', command: { kind: 'apply-asset-tree', treeCommand: { kind: 'delete-folder', folderId: folder.folder!.id, expectedVersion: 1 } } })).rejects.toMatchObject({ code: 'ASSET_FOLDER_NOT_EMPTY' })
  })
})
