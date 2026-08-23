import { describe, expect, it } from 'vitest'
import { StudyError } from '../src/protocol/error.ts'
import {
  applyAssetTreeCommand,
  assetTreePayloadHash,
  type AssetPlacementRecord,
  type AssetTreeState,
} from '../src/studio/asset-tree.ts'
import type { AssetFolderRecord, AssetTreeCommand } from '../src/studio/types.ts'

const empty: AssetTreeState = { folders: [], assets: [] }

function apply(state: AssetTreeState, commandId: string, command: AssetTreeCommand, now = 100) {
  return applyAssetTreeCommand(state, { commandId, command, now })
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected action to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(StudyError)
    expect((error as StudyError).code).toBe(code)
  }
}

describe('asset tree invariants', () => {
  it('creates normalized folders with deterministic ids and replay results', () => {
    const command = { kind: 'create-folder', namespace: 'prompt', name: '  Café  ' } as const
    const first = apply(empty, 'create-cafe', command)
    const replay = apply(first.state, 'create-cafe', command, 999)
    expect(first.value.kind).toBe('folder-upserted')
    expect(first.state.folders[0]).toMatchObject({ namespace: 'prompt', name: 'Café', sortKey: 'café', version: 1, createdAt: 100 })
    expect(replay.changed).toBe(false)
    expect(replay.value).toEqual(first.value)
    expect(replay.payloadHash).toBe(first.payloadHash)
  })

  it('requires parent and child namespaces to match', () => {
    const library = apply(empty, 'library-root', { kind: 'create-folder', namespace: 'library', name: 'Library' }).state
    const parentId = library.folders[0]!.id
    expectCode(() => apply(library, 'prompt-child', { kind: 'create-folder', namespace: 'prompt', name: 'Prompt', parentId }), 'ASSET_FOLDER_NAMESPACE_MISMATCH')
  })

  it('enforces normalized sibling-name uniqueness', () => {
    const first = apply(empty, 'first', { kind: 'create-folder', namespace: 'skill', name: 'Café' }).state
    expectCode(() => apply(first, 'second', { kind: 'create-folder', namespace: 'skill', name: 'Cafe\u0301' }), 'ASSET_FOLDER_NAME_CONFLICT')
  })

  it('rejects self-parenting and descendant cycles', () => {
    const rootResult = apply(empty, 'root', { kind: 'create-folder', namespace: 'profile', name: 'Root' })
    const root = rootResult.state.folders[0]!
    const childResult = apply(rootResult.state, 'child', { kind: 'create-folder', namespace: 'profile', name: 'Child', parentId: root.id })
    const child = childResult.state.folders.find(folder => folder.name === 'Child')!
    expectCode(() => apply(childResult.state, 'self', { kind: 'move-folder', folderId: root.id, parentId: root.id, expectedVersion: root.version }), 'ASSET_FOLDER_CYCLE')
    expectCode(() => apply(childResult.state, 'cycle', { kind: 'move-folder', folderId: root.id, parentId: child.id, expectedVersion: root.version }), 'ASSET_FOLDER_CYCLE')
  })

  it('requires exact versions for folder and asset transitions', () => {
    const created = apply(empty, 'root', { kind: 'create-folder', namespace: 'library', name: 'Root' })
    const folder = created.state.folders[0]!
    expectCode(() => apply(created.state, 'rename', { kind: 'rename-folder', folderId: folder.id, name: 'New', expectedVersion: 0 }), 'ASSET_FOLDER_VERSION_CONFLICT')
    const asset: AssetPlacementRecord = { assetId: 'source-1', namespace: 'library', version: 2, updatedAt: 10 }
    expectCode(() => apply({ folders: created.state.folders, assets: [asset] }, 'move', { kind: 'move-asset', namespace: 'library', assetId: asset.assetId, folderId: folder.id, expectedVersion: 1 }), 'STUDIO_ASSET_VERSION_CONFLICT')
  })

  it('moves assets only inside their namespace and replays idempotently', () => {
    const created = apply(empty, 'folder', { kind: 'create-folder', namespace: 'library', name: 'Books' })
    const folder = created.state.folders[0]!
    const asset: AssetPlacementRecord = { assetId: 'source-1', namespace: 'library', version: 1, updatedAt: 10 }
    const moved = apply({ folders: [folder], assets: [asset] }, 'move-source', { kind: 'move-asset', namespace: 'library', assetId: asset.assetId, folderId: folder.id, expectedVersion: 1 }, 200)
    expect(moved.value).toMatchObject({ kind: 'asset-moved', asset: { folderId: folder.id, version: 2, lastCommandId: 'move-source' } })
    expect(apply(moved.state, 'move-source', { kind: 'move-asset', namespace: 'library', assetId: asset.assetId, folderId: folder.id, expectedVersion: 1 }, 300).changed).toBe(false)
    expectCode(() => apply({ folders: [folder], assets: [asset] }, 'wrong-namespace', { kind: 'move-asset', namespace: 'skill', assetId: asset.assetId, expectedVersion: 1 }), 'STUDIO_ASSET_NAMESPACE_MISMATCH')
  })

  it('deletes only an empty folder', () => {
    const parent: AssetFolderRecord = { id: 'parent', namespace: 'library', name: 'Parent', sortKey: 'parent', version: 1, createdAt: 1, updatedAt: 1 }
    const child: AssetFolderRecord = { id: 'child', namespace: 'library', parentId: 'parent', name: 'Child', sortKey: 'child', version: 1, createdAt: 1, updatedAt: 1 }
    expectCode(() => apply({ folders: [parent, child], assets: [] }, 'delete-parent', { kind: 'delete-folder', folderId: parent.id, expectedVersion: 1 }), 'ASSET_FOLDER_NOT_EMPTY')
    const asset: AssetPlacementRecord = { assetId: 'source-1', namespace: 'library', folderId: child.id, version: 1, updatedAt: 1 }
    expectCode(() => apply({ folders: [child], assets: [asset] }, 'delete-child', { kind: 'delete-folder', folderId: child.id, expectedVersion: 1 }), 'ASSET_FOLDER_NOT_EMPTY')
    const deleted = apply({ folders: [child], assets: [] }, 'delete-empty', { kind: 'delete-folder', folderId: child.id, expectedVersion: 1 })
    expect(deleted.state.folders).toEqual([])
    expect(deleted.value).toEqual({ kind: 'folder-deleted', folderId: child.id })
  })

  it('hashes commands independently of object key order', () => {
    const left = { kind: 'move-folder', folderId: 'a', parentId: 'b', expectedVersion: 2 } as const
    const right = { expectedVersion: 2, parentId: 'b', folderId: 'a', kind: 'move-folder' } as const
    expect(assetTreePayloadHash(left)).toBe(assetTreePayloadHash(right))
  })
})
