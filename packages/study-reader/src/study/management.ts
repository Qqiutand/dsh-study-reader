/**
 * Durable-management vocabulary and validation shared by the Bookroom Remote
 * and the agent provider.  Skills are data, never executable extensions.
 */

import { createHash } from 'node:crypto'
import { StudyError } from '../protocol/error.ts'

export type FolderKind = 'library' | 'skill'
export type AgentGrant = 'library.import' | 'library.organize' | 'library.delete.propose' | 'skills.create.propose' | 'skills.edit.propose'

export const AGENT_GRANTS: readonly AgentGrant[] = ['library.import', 'library.organize', 'library.delete.propose', 'skills.create.propose', 'skills.edit.propose']

/** Every state-changing local-control request has one replayable envelope. */
export type ManagementCommand =
  | { readonly kind: 'create-folder'; readonly folderKind: FolderKind; readonly name: string; readonly parentId?: string; readonly expectedVersion?: number }
  | { readonly kind: 'rename-folder'; readonly folderId: string; readonly name: string; readonly expectedVersion: number }
  | { readonly kind: 'move-folder'; readonly folderId: string; readonly parentId?: string; readonly expectedVersion: number }
  | { readonly kind: 'delete-folder'; readonly folderId: string; readonly expectedVersion: number }
  | { readonly kind: 'move-source'; readonly sourceId: string; readonly folderId?: string; readonly expectedVersion: number }
  | { readonly kind: 'rename-source'; readonly sourceId: string; readonly title: string; readonly expectedVersion: number }
  | { readonly kind: 'set-agent-grants'; readonly grants: readonly AgentGrant[]; readonly expectedVersion: number }
  | { readonly kind: 'create-skill'; readonly name: string; readonly description: string; readonly trigger?: string; readonly instructions: string; readonly folderId?: string; readonly requiredTools?: readonly string[]; readonly userInvocable?: boolean; readonly modelInvocable?: boolean }
  | { readonly kind: 'revise-skill'; readonly skillId: string; readonly name: string; readonly description: string; readonly trigger?: string; readonly instructions: string; readonly expectedRecordVersion: number; readonly requiredTools?: readonly string[]; readonly userInvocable?: boolean; readonly modelInvocable?: boolean }
  | { readonly kind: 'archive-skill'; readonly skillId: string; readonly expectedRecordVersion: number; readonly archived: boolean }
  | { readonly kind: 'delete-skill'; readonly skillId: string; readonly expectedRecordVersion: number }
  | { readonly kind: 'move-skill'; readonly skillId: string; readonly folderId?: string; readonly expectedRecordVersion: number }
  | { readonly kind: 'clone-skill'; readonly skillId: string }
  | { readonly kind: 'create-proposal'; readonly proposalKind: ManagementProposal['kind']; readonly targetId: string; readonly title: string; readonly targetVersion: number; readonly requesterToolCallId?: string }
  | { readonly kind: 'decide-proposal'; readonly proposalId: string; readonly expectedVersion: number; readonly decision: 'approved' | 'rejected'; readonly expectedTitle?: string }

/** Stable JSON for command identities: object keys are sorted recursively. */
export function canonicalManagementPayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalManagementPayload).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalManagementPayload(record[key])}`).join(',')}}`
}

/** SHA-256 identity used for both durable receipts and proposal payload evidence. */
export function managementPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalManagementPayload(value)).digest('hex')
}

export interface ManagementFolder {
  readonly id: string
  readonly kind: FolderKind
  readonly name: string
  readonly parentId?: string
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastAppliedCommandId?: string
}

/** Operations the Host permits for one folder shown by the management UI. */
export interface ManagementFolderCapabilities {
  readonly canCreateChild: boolean
  readonly canRename: boolean
  readonly canMove: boolean
  readonly canDelete: boolean
  readonly canAcceptSkills: boolean
}

/** Durable user-managed folder projected with its server-enforced operations. */
export interface ManagedManagementFolderView extends ManagementFolder {
  readonly origin: 'managed'
  readonly capabilities: ManagementFolderCapabilities
}

/** Read-only logical folder projected from the active Harness Skill registry. */
export interface RegistryManagementFolderView {
  readonly id: string
  readonly kind: 'skill'
  readonly name: string
  readonly parentId?: string
  readonly origin: 'registry'
  readonly capabilities: ManagementFolderCapabilities
}

/** Unified folder row returned by the management Remote. */
export type ManagementFolderView = ManagedManagementFolderView | RegistryManagementFolderView

export interface StudySkillRevision {
  readonly version: number
  readonly name: string
  readonly description: string
  readonly trigger: string
  readonly instructions: string
  readonly requiredTools: readonly string[]
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly updatedAt: number
}

export interface StudySkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly trigger: string
  readonly instructions: string
  readonly requiredTools: readonly string[]
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly folderId?: string
  readonly source: 'builtin' | 'user'
  readonly version: number
  /** Optimistic record version; independent of immutable content revisions. */
  readonly recordVersion: number
  readonly archived: boolean
  readonly revisions: readonly StudySkillRevision[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastAppliedCommandId?: string
}

/** Operations the Host permits for one Skill shown by the management UI. */
export interface ManagementSkillCapabilities {
  readonly canClone: boolean
  readonly canEdit: boolean
  readonly canMove: boolean
  readonly canArchive: boolean
  readonly canDelete: boolean
}

/** Durable Study Skill projected with its server-enforced operations. */
export interface ManagedStudySkillView extends StudySkill {
  readonly origin: { readonly kind: 'managed' }
  readonly capabilities: ManagementSkillCapabilities
}

/** Safe provenance retained for a read-only Harness registry Skill. */
export type RegistryStudySkillSourceCategory = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'other'

export interface RegistryStudySkillOrigin {
  readonly kind: 'registry'
  readonly registryName: string
  readonly provider: string
  /** Fixed display category; raw provider values, paths, and URLs stay Host-side. */
  readonly sourceCategory: RegistryStudySkillSourceCategory
  readonly resourceKind?: 'directory' | 'url' | 'opaque'
}

/** Read-only Skill summary discovered from the active Harness registry view. */
export interface RegistryStudySkillView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly folderId: string
  readonly source: 'registry'
  readonly origin: RegistryStudySkillOrigin
  readonly archived: false
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
  readonly capabilities: ManagementSkillCapabilities
}

/** Unified Skill row returned by the management Remote. */
export type ManagementSkillView = ManagedStudySkillView | RegistryStudySkillView

/** Health of the optional Harness registry projection in one snapshot. */
export interface RegistrySkillCatalogStatus {
  readonly available: boolean
  readonly complete: boolean
}

/** Separate mutable library placement; Source and immutable Revision stay untouched. */
export interface SourceLocation { readonly sourceId: string; readonly folderId?: string; readonly version: number; readonly updatedAt: number; readonly lastAppliedCommandId?: string }
/** A deferred dangerous action. Approval rechecks the observed target version. */
export interface ManagementProposal {
  readonly id: string; readonly sessionId: string; readonly kind: 'delete-source' | 'archive-skill'; readonly targetId: string; readonly title: string
  readonly targetVersion: number; readonly commandPayloadHash: string; readonly requesterToolCallId?: string; readonly expiresAt: number
  readonly createdAt: number; readonly state: 'pending' | 'approved' | 'rejected'; readonly version: number; readonly lastAppliedCommandId?: string
}
/** Durable replay receipt shared by folder, Skill, binding and proposal commands. */
/** Durable receipt retains the exact typed envelope needed to finish a pending write after restart. */
export interface ManagementCommandRecord {
  readonly schemaVersion: 1
  readonly commandId: string
  readonly sessionId: string
  readonly kind: ManagementCommand['kind']
  readonly command: ManagementCommand
  readonly canonicalPayload: string
  readonly payloadHash: string
  readonly state: 'pending' | 'committed' | 'rejected'
  readonly result?: Readonly<Record<string, unknown>>
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Durable evidence for a destructive management operation, independent of row absence. */
export interface ManagementDeletionOperation {
  readonly operationId: string
  readonly kind: 'delete-source' | 'delete-folder' | 'delete-skill'
  readonly targetId: string
  readonly commandId: string
  readonly payloadHash: string
  readonly state: 'prepared' | 'applied'
  readonly result?: Readonly<Record<string, unknown>>
  readonly createdAt: number
  readonly updatedAt: number
}

/** Normalize and validate user-visible names before sibling uniqueness checks. */
export function managementName(value: string): string {
  const name = value.trim().normalize('NFC')
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) throw new StudyError('folder or skill name is invalid', 'MANAGEMENT_NAME_INVALID')
  return name
}

/**
 * Validate inert instruction text.  Safety is structural: there is no action,
 * module, shell or network field and no caller ever evaluates this text.
 */
export function managementInstructions(value: string): string {
  const instructions = value.trim()
  if (instructions.length > 12_000) throw new StudyError('skill instructions exceed 12000 characters', 'SKILL_INSTRUCTIONS_TOO_LONG')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instructions)) throw new StudyError('skill instructions contain a control character', 'SKILL_INSTRUCTIONS_INVALID')
  return instructions
}

/** Reject a caller attempting to use a trusted user actor for another session. */
export function assertTrustedManagementSession(actorSessionId: string, targetSessionId: string): void {
  if (actorSessionId !== targetSessionId) throw new StudyError('trusted actor does not own target session', 'MANAGEMENT_SESSION_FORGERY')
}

/** A small deterministic aggregate useful for durable adapters and unit tests. */
export class ManagementAggregate {
  readonly folders = new Map<string, ManagementFolder>()
  readonly skills = new Map<string, StudySkill>()
  readonly grants = new Map<string, ReadonlySet<AgentGrant>>()
  readonly proposals = new Map<string, ManagementProposal>()
  private readonly commandResults = new Map<string, { readonly payload: string; readonly result: Readonly<Record<string, unknown>> }>()

  createFolder(kind: FolderKind, rawName: string, parentId: string | undefined, expectedVersion: number | undefined, commandId: string, now = Date.now()): ManagementFolder {
    const name = managementName(rawName)
    const payload = canonicalManagementPayload({ kind, name, parentId: parentId ?? null, expectedVersion: expectedVersion ?? null })
    const payloadHash = managementPayloadHash({ kind, name, parentId: parentId ?? null, expectedVersion: expectedVersion ?? null })
    const replay = this.commandResults.get(commandId)
    if (replay !== undefined) {
      if (replay.payload !== payloadHash) throw new StudyError('commandId was reused with a different command', 'COMMAND_ID_CONFLICT')
      return replay.result.folder as ManagementFolder
    }
    // A pending receipt can be replayed after the folder write but before its
    // receipt commit. This operation-derived identity is the durable evidence.
    const id = `fld-${createHash('sha256').update(`study-management-folder:${commandId}:${payload}`).digest('hex').slice(0, 24)}`
    const applied = this.folders.get(id)
    if (applied !== undefined) return applied
    if (parentId !== undefined) {
      const parent = this.folders.get(parentId)
      if (parent === undefined || parent.kind !== kind) throw new StudyError('folder parent is invalid', 'FOLDER_PARENT_INVALID')
      if (parent.parentId !== undefined) throw new StudyError('folders support at most two levels', 'FOLDER_DEPTH_EXCEEDED')
      if (expectedVersion !== undefined && parent.version !== expectedVersion) throw new StudyError('folder version conflict', 'FOLDER_VERSION_CONFLICT')
    } else if (expectedVersion !== undefined && expectedVersion !== 0) throw new StudyError('virtual root version conflict', 'FOLDER_VERSION_CONFLICT')
    if ([...this.folders.values()].some(folder => folder.kind === kind && folder.parentId === parentId && folder.name === name)) throw new StudyError('sibling folder name already exists', 'FOLDER_NAME_CONFLICT')
    // The opaque value is a Host-derived digest, never the browser's commandId.
    const folder = { id, kind, name, ...(parentId === undefined ? {} : { parentId }), version: 1, createdAt: now, updatedAt: now }
    this.folders.set(id, folder)
    this.commandResults.set(commandId, { payload: payloadHash, result: { folder } })
    return folder
  }

  /** Restore durable command replay identity before accepting new commands. */
  restoreCommand(record: ManagementCommandRecord): void {
    if (record.state === 'committed' && record.result !== undefined) this.commandResults.set(record.commandId, { payload: record.payloadHash, result: record.result })
  }

  createSkill(raw: { readonly name: string; readonly description: string; readonly trigger?: string; readonly instructions: string; readonly folderId?: string; readonly requiredTools?: readonly string[]; readonly userInvocable?: boolean; readonly modelInvocable?: boolean }, commandId: string, now = Date.now()): StudySkill {
    const name = managementName(raw.name); const instructions = managementInstructions(raw.instructions)
    if (raw.folderId !== undefined) { const folder = this.requireFolder(raw.folderId); if (folder.kind !== 'skill') throw new StudyError('skill folder is invalid', 'SKILL_FOLDER_INVALID') }
    const id = `skill-${createHash('sha256').update(`study-skill:${commandId}`).digest('hex').slice(0, 24)}`
    const existing = this.skills.get(id); if (existing !== undefined) return existing
    const requiredTools = [...new Set(raw.requiredTools ?? [])].sort()
    const revision = { version: 1, name, description: raw.description.trim(), trigger: (raw.trigger ?? raw.description).trim(), instructions, requiredTools, userInvocable: raw.userInvocable ?? true, modelInvocable: raw.modelInvocable ?? true, updatedAt: now }
    const skill: StudySkill = { id, name, description: revision.description, trigger: revision.trigger, instructions, requiredTools, userInvocable: revision.userInvocable, modelInvocable: revision.modelInvocable, ...(raw.folderId === undefined ? {} : { folderId: raw.folderId }), source: 'user', version: 1, recordVersion: 1, archived: false, revisions: [revision], createdAt: now, updatedAt: now }
    this.skills.set(id, skill); return skill
  }

  reviseSkill(id: string, raw: { readonly name: string; readonly description: string; readonly trigger?: string; readonly instructions: string; readonly expectedRecordVersion: number; readonly requiredTools?: readonly string[]; readonly userInvocable?: boolean; readonly modelInvocable?: boolean }, now = Date.now(), commandId?: string): StudySkill {
    const prior = this.skills.get(id); if (prior === undefined) throw new StudyError('skill not found', 'SKILL_NOT_FOUND')
    if (commandId !== undefined && prior.lastAppliedCommandId === commandId) return prior
    if (prior.source !== 'user') throw new StudyError('builtin skills are read-only; clone first', 'SKILL_READ_ONLY')
    if (prior.recordVersion !== raw.expectedRecordVersion) throw new StudyError('skill record version conflict', 'SKILL_RECORD_VERSION_CONFLICT')
    const requiredTools = [...new Set(raw.requiredTools ?? prior.requiredTools ?? [])].sort()
    const revision = { version: prior.version + 1, name: managementName(raw.name), description: raw.description.trim(), trigger: (raw.trigger ?? prior.trigger ?? raw.description).trim(), instructions: managementInstructions(raw.instructions), requiredTools, userInvocable: raw.userInvocable ?? prior.userInvocable ?? true, modelInvocable: raw.modelInvocable ?? prior.modelInvocable ?? true, updatedAt: now }
    const next: StudySkill = { ...prior, name: revision.name, description: revision.description, trigger: revision.trigger, instructions: revision.instructions, requiredTools, userInvocable: revision.userInvocable, modelInvocable: revision.modelInvocable, version: revision.version, recordVersion: prior.recordVersion + 1, revisions: [...prior.revisions, revision], updatedAt: now, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }
    this.skills.set(id, next); return next
  }

  archiveSkill(id: string, expectedRecordVersion: number, archived: boolean, now = Date.now(), commandId?: string): StudySkill {
    const prior = this.skills.get(id); if (prior === undefined) throw new StudyError('skill not found', 'SKILL_NOT_FOUND')
    if (commandId !== undefined && prior.lastAppliedCommandId === commandId) return prior
    if (prior.source !== 'user') throw new StudyError('builtin skills are read-only', 'SKILL_READ_ONLY')
    if (prior.recordVersion !== expectedRecordVersion) throw new StudyError('skill record version conflict', 'SKILL_RECORD_VERSION_CONFLICT')
    const next: StudySkill = { ...prior, archived, recordVersion: prior.recordVersion + 1, updatedAt: now, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }; this.skills.set(id, next); return next
  }

  /** Remove an already-admitted Skill from the live aggregate after its durable deletion. */
  deleteSkill(id: string): void { this.skills.delete(id) }

  moveSkill(id: string, folderId: string | undefined, expectedRecordVersion: number, now = Date.now(), commandId?: string): StudySkill {
    const prior = this.skills.get(id); if (prior === undefined) throw new StudyError('skill not found', 'SKILL_NOT_FOUND')
    if (commandId !== undefined && prior.lastAppliedCommandId === commandId) return prior
    if (prior.source !== 'user') throw new StudyError('builtin skills are read-only; clone first', 'SKILL_READ_ONLY')
    if (prior.recordVersion !== expectedRecordVersion) throw new StudyError('skill record version conflict', 'SKILL_RECORD_VERSION_CONFLICT')
    if (folderId !== undefined) { const folder = this.requireFolder(folderId); if (folder.kind !== 'skill') throw new StudyError('skill folder is invalid', 'SKILL_FOLDER_INVALID') }
    const { folderId: _old, ...base } = prior; const next: StudySkill = { ...base, ...(folderId === undefined ? {} : { folderId }), recordVersion: prior.recordVersion + 1, updatedAt: now, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }; this.skills.set(id, next); return next
  }

  cloneSkill(id: string, commandId: string, now = Date.now()): StudySkill {
    const source = this.skills.get(id); if (source === undefined) throw new StudyError('skill not found', 'SKILL_NOT_FOUND')
    return this.createSkill({ name: `${source.name} 副本`, description: source.description, trigger: source.trigger, instructions: source.instructions, requiredTools: source.requiredTools, userInvocable: source.userInvocable, modelInvocable: source.modelInvocable, ...(source.folderId === undefined ? {} : { folderId: source.folderId }) }, commandId, now)
  }

  moveFolder(id: string, parentId: string | undefined, expectedVersion: number, now = Date.now(), commandId?: string): ManagementFolder {
    const folder = this.requireFolder(id)
    if (commandId !== undefined && folder.lastAppliedCommandId === commandId) return folder
    if (folder.version !== expectedVersion) throw new StudyError('folder version conflict', 'FOLDER_VERSION_CONFLICT')
    if (parentId === id) throw new StudyError('folder cannot parent itself', 'FOLDER_CYCLE')
    const parent = parentId === undefined ? undefined : this.requireFolder(parentId)
    for (let cursor = parent; cursor !== undefined; cursor = cursor.parentId === undefined ? undefined : this.folders.get(cursor.parentId)) if (cursor.id === id) throw new StudyError('folder cycle', 'FOLDER_CYCLE')
    if (parent !== undefined && (parent.kind !== folder.kind || parent.parentId !== undefined)) throw new StudyError('folder parent is invalid', 'FOLDER_PARENT_INVALID')
    if ([...this.folders.values()].some(other => other.id !== id && other.kind === folder.kind && other.parentId === parentId && other.name === folder.name)) throw new StudyError('sibling folder name already exists', 'FOLDER_NAME_CONFLICT')
    const { parentId: _oldParent, ...withoutParent } = folder
    const next: ManagementFolder = { ...withoutParent, ...(parentId === undefined ? {} : { parentId }), version: folder.version + 1, updatedAt: now, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }
    this.folders.set(id, next); return next
  }

  renameFolder(id: string, rawName: string, expectedVersion: number, now = Date.now(), commandId?: string): ManagementFolder {
    const prior = this.requireFolder(id); const name = managementName(rawName)
    if (commandId !== undefined && prior.lastAppliedCommandId === commandId) return prior
    if (prior.version !== expectedVersion) throw new StudyError('folder version conflict', 'FOLDER_VERSION_CONFLICT')
    if ([...this.folders.values()].some(folder => folder.id !== id && folder.kind === prior.kind && folder.parentId === prior.parentId && folder.name === name)) throw new StudyError('sibling folder name already exists', 'FOLDER_NAME_CONFLICT')
    const next = { ...prior, name, version: prior.version + 1, updatedAt: now, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }; this.folders.set(id, next); return next
  }

  deleteEmptyFolder(id: string, expectedVersion: number): void {
    const folder = this.requireFolder(id)
    if (folder.version !== expectedVersion) throw new StudyError('folder version conflict', 'FOLDER_VERSION_CONFLICT')
    if ([...this.folders.values()].some(value => value.parentId === id)) throw new StudyError('folder is not empty', 'FOLDER_NOT_EMPTY')
    if ([...this.skills.values()].some(value => value.folderId === id)) throw new StudyError('folder is not empty', 'FOLDER_NOT_EMPTY')
    this.folders.delete(id)
  }

  setGrants(sessionId: string, grants: readonly AgentGrant[], actor: 'user'): ReadonlySet<AgentGrant> {
    if (actor !== 'user') throw new StudyError('only the trusted UI user may set agent grants', 'GRANT_ACTOR_REJECTED')
    if (grants.some(grant => !AGENT_GRANTS.includes(grant))) throw new StudyError('unknown agent grant', 'GRANT_INVALID')
    const value = new Set(grants); this.grants.set(sessionId, value); return value
  }

  /** Agent operations must check this session-local grant before proposing work. */
  hasGrant(sessionId: string, grant: AgentGrant): boolean { return this.grants.get(sessionId)?.has(grant) === true }

  propose(sessionId: string, kind: ManagementProposal['kind'], targetId: string, title: string, targetVersion: number, commandPayload: unknown, toolCallId: string | undefined, now = Date.now(), commandId = toolCallId ?? managementPayloadHash(commandPayload)): ManagementProposal {
    const commandPayloadHash = managementPayloadHash(commandPayload)
    const id = `proposal-${createHash('sha256').update(`study-management-proposal:${commandId}:${commandPayloadHash}`).digest('hex').slice(0, 24)}`
    const existing = this.proposals.get(id)
    if (existing !== undefined) return existing
    const proposal: ManagementProposal = { id, sessionId, kind, targetId, title, targetVersion, commandPayloadHash, ...(toolCallId === undefined ? {} : { requesterToolCallId: toolCallId }), expiresAt: now + 15 * 60_000, createdAt: now, state: 'pending', version: 1 }
    this.proposals.set(proposal.id, proposal); return proposal
  }

  decideProposal(id: string, decision: 'approved' | 'rejected', actor: 'user', currentTargetVersion: number, now = Date.now(), commandId?: string): ManagementProposal {
    const proposal = this.proposals.get(id)
    if (proposal === undefined) throw new StudyError('proposal not found', 'PROPOSAL_NOT_FOUND')
    if (actor !== 'user') throw new StudyError('only a user may decide a proposal', 'PROPOSAL_ACTOR_REJECTED')
    if (commandId !== undefined && proposal.lastAppliedCommandId === commandId && proposal.state === decision) return proposal
    if (proposal.state !== 'pending' || proposal.expiresAt < now) throw new StudyError('proposal is no longer pending', 'PROPOSAL_NOT_PENDING')
    if (decision === 'approved' && proposal.targetVersion !== currentTargetVersion) throw new StudyError('proposal target changed; create a new proposal', 'PROPOSAL_STALE')
    const next = { ...proposal, state: decision, version: proposal.version + 1, ...(commandId === undefined ? {} : { lastAppliedCommandId: commandId }) }
    this.proposals.set(id, next); return next
  }

  private requireFolder(id: string): ManagementFolder { const folder = this.folders.get(id); if (folder === undefined) throw new StudyError('folder not found', 'FOLDER_NOT_FOUND'); return folder }
}
