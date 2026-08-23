/** Plugin-owned, readonly Reader Skills exposed through the native Harness registry. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { STUDY_READER_SKILLS, type StudyReaderSkillId } from '../ai/skill-catalog.ts'

export const BUNDLED_READER_SKILL_PROVIDER = 'study-reader-bundled'

interface BundledReaderSkillLocator {
  readonly kind: 'study-reader-bundled'
  readonly skillId: StudyReaderSkillId
  readonly contentHash: string
}

function resolveBundledSkillRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Source execution: src/study -> package root. Built execution:
  // lib/types/study -> package root. The first existing root wins.
  const candidates = [join(here, '..', '..', 'skills'), join(here, '..', '..', '..', 'skills')]
  const root = candidates.find(candidate => existsSync(candidate))
  if (root === undefined) throw new Error('study-reader bundled Skill directory is missing')
  return root
}

function skillFile(root: string, skillId: StudyReaderSkillId): string {
  return join(root, skillId, 'SKILL.md')
}

function skillBody(raw: string, expectedName: StudyReaderSkillId): string {
  if (!raw.startsWith('---\n')) throw new Error(`bundled Skill ${expectedName} has no frontmatter`)
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`bundled Skill ${expectedName} has invalid frontmatter`)
  const frontmatter = raw.slice(4, end)
  const declaredName = frontmatter.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim()
  if (declaredName !== expectedName) throw new Error(`bundled Skill ${expectedName} declares name ${declaredName ?? '<missing>'}`)
  return raw.slice(end + 5).trimStart()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The provider reads the active plugin package, not a copied DSH-home preset.
 * A plugin reload disposes and re-registers it, which invalidates Registry
 * snapshots. User-cloned managed Skills remain a separate provider/storage.
 */
export function bundledReaderSkillProvider(root = resolveBundledSkillRoot()): SkillProvider {
  const candidate = (skillId: StudyReaderSkillId): SkillCandidate => {
    const manifest = STUDY_READER_SKILLS.find(entry => entry.id === skillId)
    if (manifest === undefined) throw new Error(`unknown bundled Reader Skill ${skillId}`)
    const path = skillFile(root, skillId)
    const raw = readFileSync(path, 'utf8')
    const body = skillBody(raw, skillId)
    const contentHash = sha256(body)
    const locator: BundledReaderSkillLocator = { kind: 'study-reader-bundled', skillId, contentHash }
    return {
      name: skillId,
      description: manifest.description,
      whenToUse: manifest.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: BUNDLED_READER_SKILL_PROVIDER,
      rank: BUNDLED_SKILL_RANK,
      locator,
      path,
      resourceBase: { kind: 'directory', path: dirname(path) },
      metadata: { builtin: true, contentHash },
    }
  }
  return {
    name: BUNDLED_READER_SKILL_PROVIDER,
    async list(): Promise<readonly SkillCandidate[]> {
      return STUDY_READER_SKILLS.map(skill => candidate(skill.id))
    },
    async get(selected): Promise<SkillDefinition | undefined> {
      if (selected.provider !== BUNDLED_READER_SKILL_PROVIDER) return undefined
      const locator = selected.locator as Partial<BundledReaderSkillLocator> | undefined
      if (locator?.kind !== 'study-reader-bundled' || locator.skillId === undefined) return undefined
      const current = candidate(locator.skillId)
      if (current.name !== selected.name) return undefined
      const raw = readFileSync(current.path!, 'utf8')
      return { ...current, content: skillBody(raw, locator.skillId) }
    },
  }
}
