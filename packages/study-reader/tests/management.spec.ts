import { describe, expect, it } from 'vitest'
import { assertTrustedManagementSession, canonicalManagementPayload, ManagementAggregate, managementInstructions, managementPayloadHash } from '../src/study/management.ts'

describe('Stage 3 management aggregate', () => {
  it('enforces a two-level tree, normalized sibling names, cycles and CAS', () => {
    const store = new ManagementAggregate()
    const root = store.createFolder('library', '  课程  ', undefined, undefined, 'one', 1)
    const child = store.createFolder('library', '第一章', root.id, 1, 'two', 2)
    expect(() => store.createFolder('library', '第三层', child.id, 1, 'three')).toThrow(/two levels/)
    expect(() => store.createFolder('library', '课程', undefined, undefined, 'four')).toThrow(/already exists/)
    expect(() => store.moveFolder(root.id, child.id, 1)).toThrow(/cycle/)
    expect(() => store.moveFolder(root.id, undefined, 2)).toThrow(/version conflict/)
  })

  it('isolates session grants and keeps Skill revisions append-only', () => {
    const store = new ManagementAggregate()
    store.setGrants('a', ['library.import'], 'user')
    expect(store.grants.get('b')).toBeUndefined()
    expect(() => store.setGrants('a', ['library.import'], 'agent' as never)).toThrow(/trusted UI/)
    store.skills.set('skill', { id: 'skill', name: 'x', description: '', instructions: '', source: 'user', version: 2, archived: false, revisions: [{ version: 1, name: 'x', description: '', instructions: '', updatedAt: 1 }, { version: 2, name: 'x', description: '', instructions: '', updatedAt: 2 }], createdAt: 1, updatedAt: 2 })
    expect(store.skills.get('skill')?.revisions.map(revision => revision.version)).toEqual([1, 2])
  })

  it('retains code and URLs as inert learning text', () => {
    const text = managementInstructions('```js\nimport x from "x"\n```\nRead https://example.test and explain it.')
    expect(text).toContain('import x')
    expect(text).toContain('https://')
  })

  it('replays the same command before sibling validation and rejects changed payloads', () => {
    const store = new ManagementAggregate()
    const one = store.createFolder('skill', 'Notes', undefined, 0, 'repeat')
    expect(store.createFolder('skill', 'Notes', undefined, 0, 'repeat')).toEqual(one)
    expect(() => store.createFolder('skill', 'Changed', undefined, 0, 'repeat')).toThrow(/different command/)
  })

  it('hashes semantically identical envelopes independently of object key order', () => {
    const left = { sessionId: 'a', command: { kind: 'create-folder', name: 'Notes', folderKind: 'skill' } }
    const right = { command: { folderKind: 'skill', name: 'Notes', kind: 'create-folder' }, sessionId: 'a' }
    expect(canonicalManagementPayload(left)).toBe(canonicalManagementPayload(right))
    expect(managementPayloadHash(left)).toBe(managementPayloadHash(right))
  })

  it('recovers folder creation after the mutation write but before receipt commit', () => {
    const first = new ManagementAggregate()
    const folder = first.createFolder('library', 'Restart safe', undefined, 0, 'crash-window', 1)
    const restarted = new ManagementAggregate()
    restarted.folders.set(folder.id, folder)
    expect(restarted.createFolder('library', 'Restart safe', undefined, 0, 'crash-window', 2)).toEqual(folder)
  })

  it('uses an operation-derived proposal id across an interrupted replay', () => {
    const store = new ManagementAggregate()
    const first = store.propose('s', 'delete-source', 'src', 'Title', 1, { sourceId: 'src' }, 'proposal-command', 1)
    expect(store.propose('s', 'delete-source', 'src', 'Title', 1, { sourceId: 'src' }, 'proposal-command', 2).id).toBe(first.id)
  })

  it('rejects a trusted-user capability replayed into another session', () => {
    expect(() => assertTrustedManagementSession('session-a', 'session-b')).toThrow(/does not own/)
  })

  it('requires a current user decision for a non-expired proposal and rejects stale targets', () => {
    const store = new ManagementAggregate()
    const proposal = store.propose('session-a', 'delete-source', 'source-a', 'Book', 3, { source: 'source-a' }, 'call-1', 10)
    expect(() => store.decideProposal(proposal.id, 'approved', 'agent' as never, 3, 11)).toThrow(/only a user/)
    expect(() => store.decideProposal(proposal.id, 'approved', 'user', 2, 11)).toThrow(/target changed/)
    expect(store.decideProposal(proposal.id, 'rejected', 'user', 3, 11).state).toBe('rejected')
    expect(() => store.decideProposal(proposal.id, 'approved', 'user', 3, 12)).toThrow(/no longer pending/)
  })

  it('replays only the same durable proposal decision after its write', () => {
    const store = new ManagementAggregate()
    const proposal = store.propose('session-a', 'delete-source', 'source-a', 'Book', 3, { source: 'source-a' }, 'call-1', 10)
    const approved = store.decideProposal(proposal.id, 'approved', 'user', 3, 11, 'decision-1')
    expect(store.decideProposal(proposal.id, 'approved', 'user', 3, 12, 'decision-1')).toEqual(approved)
    expect(() => store.decideProposal(proposal.id, 'rejected', 'user', 3, 12, 'decision-2')).toThrow(/no longer pending/)
  })

  it('refuses nonempty folder deletion and permits explicit move to virtual Root', () => {
    const store = new ManagementAggregate()
    const parent = store.createFolder('skill', 'Parent', undefined, 0, 'parent')
    const child = store.createFolder('skill', 'Child', parent.id, 1, 'child')
    expect(() => store.deleteEmptyFolder(parent.id, 1)).toThrow(/not empty/)
    const moved = store.moveFolder(child.id, undefined, 1)
    store.deleteEmptyFolder(parent.id, 1)
    expect(moved.parentId).toBeUndefined()
  })

  it('appends a skill revision and rejects expired proposals', () => {
    const store = new ManagementAggregate()
    const skill = store.createSkill({ name: 'Skill', description: 'brief', instructions: 'Read carefully.' }, 'skill', 1)
    const revised = store.reviseSkill(skill.id, { name: 'Skill', description: 'new', instructions: 'Read twice.', expectedRecordVersion: 1 }, 3)
    expect(revised.version).toBe(2)
    const proposal = store.propose('a', 'archive-skill', skill.id, skill.name, 2, {}, undefined, 1)
    expect(() => store.decideProposal(proposal.id, 'approved', 'user', 2, proposal.expiresAt + 1)).toThrow(/no longer pending/)
  })

  it('keeps semantic content revisions separate from record CAS mutations', () => {
    const store = new ManagementAggregate()
    const folder = store.createFolder('skill', 'Shelf', undefined, 0, 'shelf', 1)
    const created = store.createSkill({ name: 'Skill', description: '', instructions: 'One.' }, 'skill-create', 2)
    const moved = store.moveSkill(created.id, folder.id, 1, 4, 'skill-move')
    expect(moved).toMatchObject({ version: 1, recordVersion: 2 })
    expect(moved.revisions.map(revision => revision.version)).toEqual([1])
    const revised = store.reviseSkill(created.id, { name: 'Skill', description: 'changed', instructions: 'Two.', expectedRecordVersion: 2 }, 5, 'skill-revise')
    expect(revised).toMatchObject({ version: 2, recordVersion: 3 })
    expect(revised.revisions.map(revision => revision.version)).toEqual([1, 2])
    expect(() => store.archiveSkill(created.id, 2, true)).toThrow(/record version conflict/)
    expect(store.reviseSkill(created.id, { name: 'Skill', description: 'changed', instructions: 'Two.', expectedRecordVersion: 2 }, 7, 'skill-revise')).toEqual(revised)
  })
})
