import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { BrowserClient, gatewayOutcome, unwrapToolResult } from '../../dist/lib/browser-client.js'
import { runRecruitmentAgent } from '../../dist/lib/recruitment-presets.js'

const job = JSON.parse(await readFile(process.argv[2], 'utf8'))
const browser = new BrowserClient({ command: process.execPath, args: [resolve('browser-agent-gateway/mcp-server.js')] })
const directory = await mkdtemp(join(tmpdir(), 'recruitment-preset-read-'))
let owned = false
const call = async (name, args = {}) => {
  const outcome = gatewayOutcome(unwrapToolResult(await browser.call(name, args)))
  if (outcome.status !== 'succeeded') throw new Error(outcome.error ?? outcome.status)
  return outcome.output
}
const key = value => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12)
async function probe(original) {
  const page = structuredClone(original)
  let resetLabels = 0, firstStep, paused
  for (const item of page.items) if (item.role === 'button' && item.name === '继续沟通') { item.name = '打招呼'; resetLabels++ }
  const stop = new Error('READ_ONLY_PRESET_PROBE_STOP')
  const names = ['task_select_candidate', 'browser_snapshot', 'browser_click', 'browser_scroll', 'browser_inspect_element']
  try {
    await runRecruitmentAgent({ system: 'read-only local replay', goal: {}, signal: new AbortController().signal,
      tools: names.map(name => ({ name, inputSchema: {}, readOnly: true, execute: async args => {
        firstStep = { name, ref: args.ref, positionRef: args.position?.ref,
          identityMatchesOriginal: job.results.some(row => row.name === args.name) }
        throw stop
      } })), isFatal: error => error === stop,
      logger: { write: (_level, event, fields) => { if (event === 'recruitment.preset_paused') paused = fields } },
    }, { job: { ...job, results: [] }, broker: { currentPage: () => page }, current: () => undefined,
      agent: () => async () => ({ status: 'stopped', turns: 0, modelMs: 0, toolMs: 0, message: 'local probe ended' }) })
  } catch (error) { if (error !== stop) throw error }
  return { resetLabels, firstStep, paused, actualBrowserInputs: 0,
    note: 'Local copy only: completed button labels changed to model the pre-send state; no real input or model request.' }
}
try {
  const tools = await browser.listTools()
  const state = await call('browser_status')
  if (!state.ready || state.busy || state.workflowTaskId || state.executionOwner) throw new Error('BROWSER_NOT_IDLE')
  await call('browser_begin'); owned = true
  const listed = await call('browser_list_tabs')
  const tabs = listed.tabs ?? []
  const tab = tabs.find(tab => tab.tabId === job.tabId)
  if (!tab) throw new Error('ORIGINAL_TAB_NOT_FOUND')
  const origin = new URL(tab.url).origin
  const policy = { allowedOrigins: [origin], riskLevel: 'read' }
  const summary = { taskId: job.id, jobName: job.jobName, platformJobs: job.platformJobs,
    tabs: tabs.map(tab => ({ tabId: tab.tabId, url: tab.url && new URL(tab.url).origin + new URL(tab.url).pathname, active: tab.active })),
    directory, observations: [] }
  for (const format of ['semantic', 'dom']) {
    const page = await call('browser_snapshot', { tabId: tab.tabId, format, viewportOnly: false, policy })
    await writeFile(join(directory, `${format}.json`), JSON.stringify(page), { mode: 0o600 })
    const items = page.items ?? []
    const relevant = items.filter(item => /打招呼|已沟通|继续沟通|职位|^沟通$/.test(String(item.name ?? '')))
    const buttons = relevant.filter(item => item.role === 'button' && /^(打招呼|已沟通|继续沟通)$/.test(item.name))
    const detail = []
    for (const item of buttons.slice(0, 3)) {
      const inspected = await call('browser_inspect_element', { tabId: tab.tabId, snapshotId: page.snapshotId,
        documentId: page.documentId, ref: item.ref, policy })
      await writeFile(join(directory, `${format}-${item.ref}.json`), JSON.stringify(inspected), { mode: 0o600 })
      detail.push({ ref: item.ref, keys: Object.keys(inspected), itemKeys: Object.keys(inspected.item ?? {}),
        contexts: (inspected.item?.contextCandidates ?? []).map(context => ({ length: context.text?.length, role: context.role })),
        contextLength: inspected.item?.context?.text?.length })
    }
    summary.observations.push({ format, snapshotId: page.snapshotId, elementCount: items.length,
      coverage: page.coverage, selectedTabs: page.selectedTabs, dialogCount: page.dialogs?.length ?? 0,
      positions: items.filter(item => item.role === 'tab' || item.name === job.jobName).map(item => ({
        ref: item.ref, role: item.role, name: item.name, elementId: item.elementId, states: item.states, parentRef: item.parentRef })),
      buttons: buttons.slice(0, 8).map(item => ({ ref: item.ref, role: item.role, name: item.name, elementId: item.elementId,
        parentRef: item.parentRef, bounds: item.bounds, states: item.states, contextLength: item.context?.text?.length,
        contextKey: key(item.context?.text) })), detail, ...(format === 'dom' ? { localProbe: await probe(page) } : {}) })
  }
  summary.toolCount = tools.length
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (owned) await call('browser_finish')
  browser.dispose()
}
