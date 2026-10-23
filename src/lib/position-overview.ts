import { sourcingMinimumScore, sourcingCandidateQualified } from '../shared/sourcing-score.js'
import { greetingRows } from './greeting-history.js'
import type { JobOption, WorkbenchJob } from '../shared/workbench.js'
import type { SourcingJob, SourcingGreeting, PositionOverview } from '../shared/sourcing.js'
export function positionOverview(options: JobOption[], tasks: WorkbenchJob[], activeId?: string): PositionOverview[] {
  return options.map(position => {
    const related = tasks.filter(task => (task as WorkbenchJob & { jobId?: string }).jobId === position.id)
    const candidates = related.filter(task => task.kind === 'talent_sourcing').flatMap(task => (task as SourcingJob).candidates.filter(person => sourcingCandidateQualified(person, sourcingMinimumScore(task as SourcingJob))))
    const candidateKeys = new Map(related.filter(task => task.kind === 'talent_sourcing').flatMap(task => (task as SourcingJob).candidates.flatMap(person =>
      [person.key, ...(person.identityAliases ?? [])].map(alias => [`${person.platform}:${alias}`, person.key] as const))))
    return { ...position, candidateCount: new Set(candidates.map(person => person.key)).size,
      resumeCount: new Set(candidates.filter(person => person.scope === 'online').map(person => person.key)).size,
      greetedCount: new Set(greetingRows(related).filter(row => row.clickedAt || row.confirmedAt || (row as any).knownContacted).map(row => {
        const linked = row as Partial<SourcingGreeting>
        return linked.platform && linked.candidateKey ? `${linked.platform}:candidate:${candidateKeys.get(`${linked.platform}:${linked.candidateKey}`) ?? linked.candidateKey}` : row.key
      })).size,
      importedCount: related.filter(task => task.kind === 'resume_import').flatMap(task => task.results).filter(row => row.stage === 'succeeded').length,
      activeKind: related.find(task => task.id === activeId)?.kind }
  })
}
