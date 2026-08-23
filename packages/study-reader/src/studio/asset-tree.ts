/** Pure asset-tree transitions shared by durable adapters and tests. */

import { createHash } from 'node:crypto'
import { StudyError } from '../protocol/error.ts'
import type { AssetFolderRecord, AssetNamespace, AssetTreeCommand } from './types.ts'

/** Mutable placement metadata for a typed Studio asset. */
export interface AssetPlacementRecord {
  readonly assetId: string
  readonly namespace: AssetNamespace
  readonly folderId?: string
  readonly version: number
  readonly updatedAt: number
  readonly lastCommandId?: string
}

/** Immutable input projection consumed by one asset-tree transition. */
export interface AssetTreeState {
  readonly folders: readonly AssetFolderRecord[]
  readonly assets: readonly AssetPlacementRecord[]
}

/** Explicit command metadata required for deterministic ids and timestamps. */
export interface AssetTreeCommandEnvelope {
  readonly commandId: string
  readonly command: AssetTreeCommand
  readonly now: number
}

export type AssetTreeTransitionValue =
  | { readonly kind: 'folder-upserted'; readonly folder: AssetFolderRecord }
  | { readonly kind: 'folder-deleted'; readonly folderId: string }
  | { readonly kind: 'asset-moved'; readonly asset: AssetPlacementRecord }

/** Deterministic transition output suitable for a durable command receipt. */
export interface AssetTreeTransition {
  readonly commandId: string
  readonly payloadHash: string
  readonly changed: boolean
  readonly value: AssetTreeTransitionValue
  readonly state: AssetTreeState
}

/**
 * Apply one typed tree command without mutating the supplied state.
 * @param state - Current folders and asset placements.
 * @param envelope - Command, stable command id, and caller-owned timestamp.
 * @returns New state plus a deterministic receipt value.
 */
export function applyAssetTreeCommand(state: AssetTreeState, envelope: AssetTreeCommandEnvelope): AssetTreeTransition {
  const commandId = requireCommandId(envelope.commandId)
  const payloadHash = assetTreePayloadHash(envelope.command)
  const folders = new Map(state.folders.map(folder => [folder.id, folder]))
  const assets = new Map(state.assets.map(asset => [asset.assetId, asset]))
  const finish = (changed: boolean, value: AssetTreeTransitionValue): AssetTreeTransition => ({
    commandId,
    payloadHash,
    changed,
    value,
    state: { folders: [...folders.values()], assets: [...assets.values()] },
  })

  switch (envelope.command.kind) {
    case 'create-folder': {
      const command = envelope.command
      const name = assetFolderName(command.name)
      const id = deterministicFolderId(commandId)
      const prior = folders.get(id)
      if (prior !== undefined) {
        const same = prior.lastCommandId === commandId
          && prior.namespace === command.namespace
          && prior.parentId === command.parentId
          && prior.name === name
        if (!same) throw new StudyError('commandId was reused with a different folder command', 'COMMAND_ID_CONFLICT')
        return finish(false, { kind: 'folder-upserted', folder: prior })
      }
      const parent = command.parentId === undefined ? undefined : requireFolder(folders, command.parentId)
      if (parent !== undefined && parent.namespace !== command.namespace) {
        throw new StudyError('folder parent belongs to another namespace', 'ASSET_FOLDER_NAMESPACE_MISMATCH')
      }
      assertUniqueSiblingName(folders, command.namespace, command.parentId, name)
      const folder: AssetFolderRecord = {
        id,
        namespace: command.namespace,
        ...(command.parentId === undefined ? {} : { parentId: command.parentId }),
        name,
        sortKey: assetFolderSortKey(name),
        version: 1,
        createdAt: envelope.now,
        updatedAt: envelope.now,
        lastCommandId: commandId,
      }
      folders.set(id, folder)
      return finish(true, { kind: 'folder-upserted', folder })
    }
    case 'rename-folder': {
      const command = envelope.command
      const prior = requireFolder(folders, command.folderId)
      const name = assetFolderName(command.name)
      if (prior.lastCommandId === commandId) {
        if (prior.name !== name) throw new StudyError('commandId was reused with a different folder command', 'COMMAND_ID_CONFLICT')
        return finish(false, { kind: 'folder-upserted', folder: prior })
      }
      assertFolderVersion(prior, command.expectedVersion)
      assertUniqueSiblingName(folders, prior.namespace, prior.parentId, name, prior.id)
      const folder = { ...prior, name, sortKey: assetFolderSortKey(name), version: prior.version + 1, updatedAt: envelope.now, lastCommandId: commandId }
      folders.set(folder.id, folder)
      return finish(true, { kind: 'folder-upserted', folder })
    }
    case 'move-folder': {
      const command = envelope.command
      const prior = requireFolder(folders, command.folderId)
      if (prior.lastCommandId === commandId) {
        if (prior.parentId !== command.parentId) throw new StudyError('commandId was reused with a different folder command', 'COMMAND_ID_CONFLICT')
        return finish(false, { kind: 'folder-upserted', folder: prior })
      }
      assertFolderVersion(prior, command.expectedVersion)
      if (command.parentId === prior.id) throw new StudyError('folder cannot parent itself', 'ASSET_FOLDER_CYCLE')
      const parent = command.parentId === undefined ? undefined : requireFolder(folders, command.parentId)
      if (parent !== undefined && parent.namespace !== prior.namespace) {
        throw new StudyError('folder parent belongs to another namespace', 'ASSET_FOLDER_NAMESPACE_MISMATCH')
      }
      for (let cursor = parent; cursor !== undefined; cursor = cursor.parentId === undefined ? undefined : folders.get(cursor.parentId)) {
        if (cursor.id === prior.id) throw new StudyError('folder cannot move into its descendant', 'ASSET_FOLDER_CYCLE')
      }
      assertUniqueSiblingName(folders, prior.namespace, command.parentId, prior.name, prior.id)
      const { parentId: _priorParent, ...base } = prior
      const folder: AssetFolderRecord = {
        ...base,
        ...(command.parentId === undefined ? {} : { parentId: command.parentId }),
        version: prior.version + 1,
        updatedAt: envelope.now,
        lastCommandId: commandId,
      }
      folders.set(folder.id, folder)
      return finish(true, { kind: 'folder-upserted', folder })
    }
    case 'delete-folder': {
      const command = envelope.command
      const prior = requireFolder(folders, command.folderId)
      assertFolderVersion(prior, command.expectedVersion)
      if ([...folders.values()].some(folder => folder.parentId === prior.id)) {
        throw new StudyError('folder contains child folders', 'ASSET_FOLDER_NOT_EMPTY')
      }
      if ([...assets.values()].some(asset => asset.folderId === prior.id)) {
        throw new StudyError('folder contains assets', 'ASSET_FOLDER_NOT_EMPTY')
      }
      folders.delete(prior.id)
      return finish(true, { kind: 'folder-deleted', folderId: prior.id })
    }
    case 'move-asset': {
      const command = envelope.command
      const prior = assets.get(command.assetId)
      if (prior === undefined) throw new StudyError('asset placement not found', 'STUDIO_ASSET_NOT_FOUND')
      if (prior.namespace !== command.namespace) throw new StudyError('asset belongs to another namespace', 'STUDIO_ASSET_NAMESPACE_MISMATCH')
      if (prior.lastCommandId === commandId) {
        if (prior.folderId !== command.folderId) throw new StudyError('commandId was reused with a different asset command', 'COMMAND_ID_CONFLICT')
        return finish(false, { kind: 'asset-moved', asset: prior })
      }
      if (prior.version !== command.expectedVersion) throw new StudyError('asset placement version conflict', 'STUDIO_ASSET_VERSION_CONFLICT')
      if (command.folderId !== undefined) {
        const folder = requireFolder(folders, command.folderId)
        if (folder.namespace !== command.namespace) throw new StudyError('asset folder belongs to another namespace', 'STUDIO_ASSET_NAMESPACE_MISMATCH')
      }
      const { folderId: _priorFolder, ...base } = prior
      const asset: AssetPlacementRecord = {
        ...base,
        ...(command.folderId === undefined ? {} : { folderId: command.folderId }),
        version: prior.version + 1,
        updatedAt: envelope.now,
        lastCommandId: commandId,
      }
      assets.set(asset.assetId, asset)
      return finish(true, { kind: 'asset-moved', asset })
    }
    default:
      return assertNever(envelope.command)
  }
}

/**
 * Normalize one user-visible folder name.
 * @param value - Raw name supplied by the caller.
 * @returns Trimmed NFC text.
 */
export function assetFolderName(value: string): string {
  const name = value.trim().normalize('NFC')
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new StudyError('asset folder name is invalid', 'ASSET_FOLDER_NAME_INVALID')
  }
  return name
}

/**
 * Compute a locale-independent folder sort key.
 * @param name - Normalized folder name.
 * @returns Case-folded NFC key.
 */
export function assetFolderSortKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Hash one typed command for durable receipt comparison.
 * @param command - Asset-tree command.
 * @returns Lowercase hexadecimal SHA-256.
 */
export function assetTreePayloadHash(command: AssetTreeCommand): string {
  return createHash('sha256').update(canonicalJson(command)).digest('hex')
}

function deterministicFolderId(commandId: string): string {
  return `studio-folder-${createHash('sha256').update(`study-studio-folder:${commandId}`).digest('hex').slice(0, 24)}`
}

function requireCommandId(value: string): string {
  if (value.trim() === '' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new StudyError('commandId is invalid', 'COMMAND_ID_INVALID')
  return value
}

function requireFolder(folders: ReadonlyMap<string, AssetFolderRecord>, folderId: string): AssetFolderRecord {
  const folder = folders.get(folderId)
  if (folder === undefined) throw new StudyError('asset folder not found', 'ASSET_FOLDER_NOT_FOUND')
  return folder
}

function assertFolderVersion(folder: AssetFolderRecord, expectedVersion: number): void {
  if (folder.version !== expectedVersion) throw new StudyError('asset folder version conflict', 'ASSET_FOLDER_VERSION_CONFLICT')
}

function assertUniqueSiblingName(
  folders: ReadonlyMap<string, AssetFolderRecord>,
  namespace: AssetNamespace,
  parentId: string | undefined,
  name: string,
  excludedId?: string,
): void {
  if ([...folders.values()].some(folder => folder.id !== excludedId && folder.namespace === namespace && folder.parentId === parentId && folder.name === name)) {
    throw new StudyError('sibling asset folder name already exists', 'ASSET_FOLDER_NAME_CONFLICT')
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('asset tree commands must contain only JSON values')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported asset tree command: ${JSON.stringify(value)}`)
}
