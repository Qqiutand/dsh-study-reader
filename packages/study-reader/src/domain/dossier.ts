/**
 * Metacognitive study dossier synthesis. The report is source-scoped and
 * combines argument structure, Feynman explanations, friction points,
 * calibration/self-test comparison, bookmarks, and retrieval practice.
 * @module dsh-study-reader/domain/dossier
 */

import { DossierId, mintId, type RevisionId, type SourceId } from '../protocol/ids.ts'
import type { StudyRequestState, StudySessionState } from './types.ts'

export interface GeneratedDossier {
  readonly id: DossierId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly title: string
  readonly content: string
  readonly createdAt: number
}

const RATING_LABEL: Record<'fuzzy' | 'rough' | 'clear' | 'teach', string> = {
  fuzzy: '模糊',
  rough: '大概懂',
  clear: '清晰',
  teach: '能教别人',
}

/** Synthesize a comprehensive dossier from the derived durable event state. */
export function synthesizeDossier(
  sourceTitle: string,
  state: StudySessionState,
  now: number = Date.now(),
  requestedSourceId?: SourceId,
  requestedRevisionId?: RevisionId,
): GeneratedDossier {
  const sourceId = requestedSourceId ?? state.currentSourceId ?? ('' as SourceId)
  const matchesRevision = (revisionId: RevisionId | undefined): boolean =>
    requestedRevisionId === undefined || revisionId === undefined || revisionId === requestedRevisionId
  const dateStr = new Date(now).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const requests = Object.values(state.activeRequests)
    .filter(request => (request.sourceId === undefined || request.sourceId === sourceId) && matchesRevision(request.revisionId))
  const highlights = state.highlights.filter(item => item.sourceId === sourceId && matchesRevision(item.revisionId))
  const bookmarks = state.bookmarks.filter(item => item.sourceId === sourceId && matchesRevision(item.revisionId))
  const frictions = state.frictions.filter(item => item.sourceId === sourceId && matchesRevision(item.revisionId))
  const cards = state.reviewCards.filter(item => item.sourceId === sourceId && matchesRevision(item.revisionId))

  const lines: string[] = []
  lines.push(`# 📑 《${sourceTitle}》· 深度研读复盘手记`)
  lines.push(`> 📅 生成日期：${dateStr} | 📚 PDF/EPUB 结构化锚点与认知复盘\n`)

  lines.push('## 🎯 一、论证结构（图尔敏）')
  const toulminEntries = requests.filter(entry => entry.toulmin !== undefined)
  if (toulminEntries.length === 0) {
    lines.push('*本次研读未保存图尔敏论证拆解。*\n')
  } else {
    toulminEntries.forEach((entry, index) => {
      const value = entry.toulmin!
      lines.push(`### 论点 #${index + 1}${locationSuffix(entry)}`)
      lines.push(`- **核心主张**：${value.claim}`)
      lines.push('- **证据**：')
      for (const evidence of value.evidence) {
        lines.push(`  - ${evidence.text} *(P.${evidence.page}${evidence.blockId ? ` §${evidence.blockId}` : ''})*`)
      }
      lines.push(`- **推导桥梁**：${value.warrant}`)
      if (value.backing) lines.push(`- **理论支撑**：${value.backing}`)
      if (value.qualifier) lines.push(`- **适用边界**：${value.qualifier}`)
      if (value.rebuttal) lines.push(`- **潜在反驳**：${value.rebuttal}`)
      lines.push('')
    })
  }

  lines.push('## 💡 二、概念理解（费曼）')
  const feynmanEntries = requests.filter(entry => entry.feynman !== undefined)
  if (feynmanEntries.length === 0) {
    lines.push('*本次研读未保存费曼释义。*\n')
  } else {
    feynmanEntries.forEach((entry, index) => {
      const value = entry.feynman!
      lines.push(`### 释义 #${index + 1}${locationSuffix(entry)}`)
      lines.push(`- **直观类比**：${value.intuitiveAnalogy}`)
      lines.push(`- **上下文作用**：${value.contextRole}`)
      if (value.terminologyMapping.length > 0) {
        lines.push('- **术语映射**：')
        value.terminologyMapping.forEach(item => lines.push(`  - ${item.term}：${item.meaning}`))
      }
      if (value.citations.length > 0) {
        lines.push('- **原文锚点**：')
        value.citations.forEach(citation => {
          lines.push(`  - P.${citation.page}${citation.blockId ? ` §${citation.blockId}` : ''}：「${citation.quote}」`)
        })
      }
      lines.push('')
    })
  }

  lines.push('## 📊 三、认知校准')
  const calibrated = requests.filter(entry => entry.calibrations !== undefined)
  if (calibrated.length === 0) {
    lines.push('*未记录解释前/后的理解置信度。*\n')
  } else {
    lines.push('| 锚点 | 解释前 | 解释后 | 自测 | 判断 |')
    lines.push('| :--- | :--- | :--- | :--- | :--- |')
    calibrated.forEach((entry, index) => {
      const pre = entry.calibrations?.['pre-explanation']
      const post = entry.calibrations?.['post-explanation']
      const assessment = entry.lastAssessment
      const verdict = calibrationVerdict(entry)
      lines.push(`| #${index + 1}${locationSuffix(entry)} | ${pre ? RATING_LABEL[pre.rating] : '—'} | ${post ? RATING_LABEL[post.rating] : '—'} | ${assessment ? (assessment.passed ? '通过' : '未通过') : '—'} | ${verdict} |`)
    })
    lines.push('')
  }

  lines.push('## ⚡ 四、认知卡点与突破')
  if (frictions.length === 0) {
    lines.push('*未记录显著卡点。*\n')
  } else {
    frictions.forEach((friction, index) => {
      lines.push(`### 卡点 #${index + 1}：${friction.topic}（P.${friction.page}）`)
      lines.push(`- **困惑**：${friction.description}`)
      if (friction.resolution) lines.push(`- **解决**：${friction.resolution}`)
      if (friction.blockIds.length > 0) lines.push(`- **Block**：${friction.blockIds.join(', ')}`)
      lines.push('')
    })
  }

  lines.push('## ⭐ 五、收藏与高亮')
  lines.push(`- 高亮：${highlights.length} 条`)
  if (bookmarks.length === 0) {
    lines.push('- 收藏：0 条\n')
  } else {
    lines.push(`- 收藏：${bookmarks.length} 条`)
    bookmarks.forEach((bookmark, index) => {
      lines.push(`  ${index + 1}. **P.${bookmark.page}**：「${bookmark.text}」`)
      if (bookmark.note) lines.push(`     - 笔记：${bookmark.note}`)
    })
    lines.push('')
  }

  lines.push('## 🧠 六、间隔复习提取练习')
  if (cards.length === 0) {
    lines.push('*当前文献没有复习卡片。*\n')
  } else {
    cards.forEach((card, index) => {
      lines.push(`**Q${index + 1}（P.${card.page}）**：${card.question}`)
      lines.push(`> **参考要点**：${card.answer}`)
      lines.push(`> 下次到期：${new Date(card.nextDueAt).toLocaleDateString('zh-CN')}\n`)
    })
  }

  return {
    id: mintId<DossierId>('dossier'),
    sourceId,
    ...(requestedRevisionId !== undefined ? { revisionId: requestedRevisionId } : {}),
    title: `${sourceTitle} - 研读复盘手记`,
    content: lines.join('\n'),
    createdAt: now,
  }
}

function locationSuffix(entry: StudyRequestState): string {
  const page = entry.page === undefined ? '' : ` · P.${entry.page}`
  const block = entry.blockIds?.[0] === undefined ? '' : ` §${entry.blockIds[0]}`
  return page === '' && block === '' ? '' : `（${page.replace(/^ · /, '')}${block}）`
}

function calibrationVerdict(entry: StudyRequestState): string {
  const pre = entry.calibrations?.['pre-explanation']
  const post = entry.calibrations?.['post-explanation']
  const assessment = entry.lastAssessment
  if (assessment !== undefined && !assessment.passed && (post?.rating === 'clear' || post?.rating === 'teach')) {
    return '⚠️ 可能过度自信'
  }
  if (assessment?.passed === true && (pre?.rating === 'fuzzy' || pre?.rating === 'rough')) {
    return '✅ 学习后验证通过'
  }
  if (pre !== undefined && post !== undefined && pre.rating === post.rating) return '稳定'
  if (pre !== undefined && post !== undefined) return '置信度发生变化'
  return '信息不足'
}
