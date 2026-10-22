import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Load the packaged skill, keeping catalog metadata and instructions in one file. */
export function bundledSkill(name: string): SkillRegistration {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid bundled skill name')
  const directory = new URL(`../../skills/${name}/`, import.meta.url)
  const path = fileURLToPath(new URL('SKILL.md', directory))
  const document = readFileSync(path, 'utf8')
  const parsed = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(document)
  if (!parsed || parsed[1] !== name) throw new Error(`Invalid bundled ${name} skill`)
  return {
    name: parsed[1], description: parsed[2], content: parsed[3].trim(),
    source: 'bundled', provider: 'dsh-ai-recruiter', path,
    resourceBase: { kind: 'directory', path: fileURLToPath(directory) },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}
export const browserSkill = () => bundledSkill('xinzhao-browser-control')
export const recruitmentMatchingSkill = () => bundledSkill('recruitment-matching')
