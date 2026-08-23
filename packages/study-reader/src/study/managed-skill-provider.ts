/** Harness Skill provider for the exact managed Skill revisions pinned by a Session Profile. */
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillViewOptions,
} from '@deepseek-ai/dsh-skill'
import type { StudyService } from './study-service.ts'

function sessionIdFrom(options: SkillLookupOptions): string | undefined {
  const scope = (options as SkillViewOptions).scope as {
    readonly id?: unknown
    readonly session?: { readonly id?: unknown }
  } | undefined
  const value = scope?.session?.id ?? scope?.id
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function managedProfileSkillProvider(service: StudyService): SkillProvider {
  return {
    name: 'study-profile-managed',
    async list(options): Promise<readonly SkillCandidate[]> {
      const sessionId = sessionIdFrom(options)
      return sessionId === undefined ? [] : service.listManagedProfileSkillCandidates(sessionId)
    },
    async get(candidate, options): Promise<SkillDefinition | undefined> {
      const sessionId = sessionIdFrom(options)
      return sessionId === undefined ? undefined : service.loadManagedProfileSkill(sessionId, candidate)
    },
  }
}
