import type { ReaderCapability, ReaderHost, ReaderToolName, StudyReaderProfile } from './contracts.ts'

export const STUDY_READER_SKILL_IDS = [
  'trace-argument', 'reconstruct-proof', 'synthesize-sources', 'generate-practice',
  'assess-understanding', 'organize-study', 'save-study-note',
] as const
export type StudyReaderSkillId = typeof STUDY_READER_SKILL_IDS[number]
type IntentKey = 'argument' | 'proof' | 'crossDocument' | 'practice' | 'assessment' | 'organize' | 'saveNote'
type SkillActivation = { readonly mode: 'automatic' } | { readonly mode: 'conditional' | 'explicit'; readonly intent: IntentKey }

export interface DetectedTurnIntents {
  readonly argument: boolean
  readonly proof: boolean
  readonly crossDocument: boolean
  readonly practice: boolean
  readonly assessment: boolean
  readonly organize: boolean
  readonly saveNote: boolean
}

export interface StudyReaderSkillManifest {
  readonly id: StudyReaderSkillId
  readonly title: string
  readonly description: string
  readonly activation: SkillActivation
  readonly allowedTools: readonly ReaderToolName[]
  readonly requiredCapabilities?: readonly ReaderCapability[]
}

export const STUDY_READER_SKILLS: readonly StudyReaderSkillManifest[] = [
  { id: 'trace-argument', title: '追踪论证', description: '仅在用户要求梳理论证链、前提、推论、隐含假设或结论时使用；普通解释不使用，形式证明优先使用证明重建。', activation: { mode: 'conditional', intent: 'argument' }, allowedTools: ['reader_search_passages', 'reader_read_passage'] },
  { id: 'reconstruct-proof', title: '重建证明', description: '仅在用户明确讨论定理、证明、推导或证明缺口时使用。', activation: { mode: 'conditional', intent: 'proof' }, allowedTools: ['reader_search_passages', 'reader_read_passage'] },
  { id: 'synthesize-sources', title: '跨文档综合', description: '仅在用户明确要求综合多个文档、作者或整个书房时使用。', activation: { mode: 'conditional', intent: 'crossDocument' }, allowedTools: ['reader_list_documents', 'reader_get_outline', 'reader_search_passages', 'reader_read_passage'], requiredCapabilities: ['documents.list', 'passages.search'] },
  { id: 'generate-practice', title: '生成练习', description: '仅在用户明确要求题目、测验或练习时使用；不得自行启动。', activation: { mode: 'explicit', intent: 'practice' }, allowedTools: ['reader_get_outline', 'reader_search_passages', 'reader_read_passage'] },
  { id: 'assess-understanding', title: '评估理解', description: '仅在用户提交答案、复述或明确要求检查理解时使用。', activation: { mode: 'explicit', intent: 'assessment' }, allowedTools: ['reader_search_passages', 'reader_read_passage'] },
  { id: 'organize-study', title: '组织学习', description: '仅在用户明确要求学习提纲、概念依赖、复习顺序或计划时使用。', activation: { mode: 'explicit', intent: 'organize' }, allowedTools: ['reader_get_outline', 'reader_search_passages', 'reader_read_passage'] },
  { id: 'save-study-note', title: '保存学习笔记', description: '仅在用户明确要求把内容保存或写入书房笔记时使用；生成草稿不触发写入。', activation: { mode: 'explicit', intent: 'saveNote' }, allowedTools: ['reader_search_passages', 'reader_read_passage', 'reader_save_note'], requiredCapabilities: ['notes.save'] },
]

export function detectTurnIntents(userMessage: string): DetectedTurnIntents {
  const text = userMessage.normalize('NFKC')
  return {
    argument: /论证链|论证结构|前提.{0,12}(?:结论|推论)|隐含假设|argument\s+(?:chain|structure)|trace.{0,12}argument/i.test(text),
    proof: /证明|定理|引理|推导过程|证明过程|证明缺口|proof|theorem|lemma|derive|derivation/i.test(text),
    crossDocument: /跨文档|跨资料|多个文档|多篇文章|这些文档|整个书房|不同作者|两本书|across\s+(?:documents|sources)|multiple\s+(?:documents|sources)/i.test(text),
    practice: /(?:出|生成|设计|创建|给我).{0,16}(?:题|练习|测验|测试题|quiz|questions?)|(?:题|练习|测验).{0,12}(?:生成|设计)/i.test(text),
    assessment: /检查.{0,12}(?:答案|理解|复述)|批改|评估.{0,12}(?:答案|理解)|我(?:这样|这么)理解.{0,8}(?:对吗|是否正确)|grade\s+my|check\s+my\s+(?:answer|understanding)/i.test(text),
    organize: /学习计划|复习计划|学习顺序|复习顺序|知识结构|概念依赖|概念图|学习提纲|课程安排|study\s+plan|review\s+plan|concept\s+map/i.test(text),
    saveNote: /(?:保存|写入|加入|添加|记录到).{0,16}(?:书房|笔记|学习笔记)|save.{0,12}(?:note|study\s+space)|add.{0,12}note/i.test(text),
  }
}

export function skillManifest(id: string): StudyReaderSkillManifest | undefined { return STUDY_READER_SKILLS.find(skill => skill.id === id) }

export function skillAllowedForTurn(manifest: StudyReaderSkillManifest, intents: DetectedTurnIntents, host: ReaderHost, profile: StudyReaderProfile): boolean {
  if (manifest.activation.mode !== 'automatic' && !intents[manifest.activation.intent]) return false
  if (!(manifest.requiredCapabilities ?? []).every(capability => host.capabilities.has(capability))) return false
  return manifest.allowedTools.some(tool => profile.allowedTools.has(tool))
}
