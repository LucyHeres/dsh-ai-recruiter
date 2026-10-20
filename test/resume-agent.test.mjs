import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runResumeAgent } from '../dist/lib/resume-agent.js'
import { runBrowserAgent } from '../dist/lib/browser-agent.js'
import { AgentBrowserTools } from '../dist/lib/agent-browser-tools.js'
import { readFile } from 'node:fs/promises'

const origin = 'https://lpt.liepin.com'
const properties = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const info = (name, readOnly, schema = properties) => ({ name, description: 'Dynamic browser operation',
  annotations: { readOnlyHint: readOnly }, inputSchema: { type: 'object', properties: schema, required: ['tabId'], additionalProperties: false },
  _meta: { browserAgent: { available: true, capability: name.replace('_', '.') } } })
const infos = [info('browser_snapshot', true, { tabId: properties.tabId }), info('browser_unfamiliar_operation', false),
  info('browser_acquire_file', false), info('browser_capture_content', false)]
const page = n => ({ tabId: 1, snapshotId: `s${n}`, documentId: 'document', url: `${origin}/opaque`, text: 'Casey 研究成果',
  items: [{ ref: 'candidate', role: 'article', name: 'Casey 研究成果' },
    { ref: 'attachment', role: 'button', name: `artifact ${n}`, context: { text: 'Casey 研究成果' } }] })
const snapshot = { name: 'browser_snapshot', args: { tabId: 1 } }
const select = { name: 'task_select_candidate', args: { tabId: 1, snapshotId: 's1', ref: 'candidate', name: 'Casey' } }
const navigate = { name: 'browser_unfamiliar_operation', args: { tabId: 1, snapshotId: 's1', ref: 'candidate', purpose: 'navigation' } }
const ingest = (snapshotId = 's2') => ({ name: 'task_import_attachment', args: { tabId: 1, snapshotId, ref: 'attachment' } })
const finish = { name: 'task_finish', args: { reason: '当前可处理内容已完成' } }

async function fixture(steps, options = {}) {
  const signal = options.signal ?? new AbortController().signal
  const job = { kind: 'resume_import', id: 'test-resume', platform: 'liepin', tabId: 1, status: 'running',
    limit: options.limit ?? 1, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', results: options.initialResults ?? [], detail: '' }
  const requests = [], calls = [], saved = []; let snapshots = 0, imports = 0
  const registry = [...infos, ...(options.infos ?? []), ...(options.startupTabs ? [{ name: 'browser_list_tabs', description: 'tabs',
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { browserAgent: { available: true } } }] : [])]
  const broker = new AgentBrowserTools(registry, async (name, args, toolSignal) => {
    calls.push({ name, args })
    if (name === 'browser_list_tabs') return { tabs: options.startupTabs }
    if (name === 'browser_snapshot') return (options.page ?? page)(++snapshots)
    if (name === 'browser_inspect_element') return options.inspect ? options.inspect(args, snapshots, toolSignal) : { item: (options.page ?? page)(snapshots).items.find(item => item.ref === args.ref) }
    if (options.navigationError && name === 'browser_unfamiliar_operation') throw new Error(options.navigationError)
    return { dispatched: true }
  }, { origins: [origin], signal, confirmationId: 'resume-test' })
  const llm = { async *stream(request) {
    requests.push(request)
    const next = steps.shift(); assert.ok(next, 'Unexpected model turn')
    const actions = typeof next === 'function' ? next(request) : next
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: `${requests.length}-${index}`, name: action.name, arguments: JSON.stringify(action.args) } }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  let error
  try {
    await runResumeAgent({ job, signal, broker, priorJobs: options.priorJobs ?? [],
      goal: options.goal,
      agent: options.agent ?? (input => runBrowserAgent(llm, { provider: 'test', model: 'continuous-agent' }, { ...input, maxTurns: steps.length + 2 })),
      progress: async (phase, message) => saved.push({ phase, message, job: structuredClone(job) }),
      ingest: async (ref, observed, result, toolSignal) => {
        imports++
        assert.ok(toolSignal instanceof AbortSignal)
        assert.notEqual(toolSignal, signal, 'ingest receives the core deadline signal as well as user cancellation')
        const persisted = saved.at(-1).job.results.at(-1)
        assert.equal(persisted.stage, 'sending'); assert.ok(persisted.attemptedAt)
        assert.equal(ref, 'attachment'); assert.equal(observed.tabId, job.tabId)
        if (options.importingError) { job.phase = 'importing'; throw new Error(options.importingError) }
        if (options.captureError && imports === 1) throw new Error(options.captureError)
        result.stage = options.outcome ?? 'succeeded'; result.detail = 'existing upload receipt'
      } })
  } catch (caught) { error = caught }
  return { job, requests, calls, saved, imports, error }
}

test('a liepin apply page without a confirmed received-resume tab cannot select or import a candidate', async () => {
  const out = await fixture([[snapshot], [select], [finish]], { page: number => ({ ...page(number), url: `${origin}/resume/apply` }) })
  assert.equal(out.error, undefined)
  assert.equal(out.imports, 0)
  assert.equal(out.job.results.length, 0)
  assert.match(JSON.stringify(out.requests), /RESUME_RECEIVED_TAB_REQUIRED/)
})

test('resume uses the shared native conversation and dynamically supplied browser tools', async () => {
  const out = await fixture([[snapshot], [select, navigate], [snapshot], [ingest(), navigate]])
  assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.imports, 1)
  assert.deepEqual(out.calls.map(call => call.name), ['browser_snapshot', 'browser_unfamiliar_operation', 'browser_snapshot'])
  assert.equal(out.job.results[0].stage, 'succeeded')
  assert.equal(out.saved[0].job.results[0].attemptedAt, undefined, 'selection records without triggering download or upload')
  assert.ok(out.requests[2].messages.length > out.requests[1].messages.length)
  const names = out.requests[0].tools.map(tool => tool.name)
  assert.ok(names.includes('browser_unfamiliar_operation'))
  assert.ok(!names.includes('browser_acquire_file')); assert.ok(!names.includes('browser_capture_content'))
})

test('semantic readable occluded candidate and disabled evidence establish identity without requiring clickability', async () => {
  const out = await fixture([[snapshot], [{ ...select, args: { ...select.args, evidenceRefs: ['supplement'] } }, navigate], [snapshot], [ingest()]], {
    page: n => { const p = page(n); p.format = 'semantic'; p.items[0].states = ['occluded'];
      p.items.push({ ref: 'supplement', role: 'text', name: 'Casey 研究成果', states: ['disabled'] }); return p },
  })
  assert.equal(out.error, undefined); assert.equal(out.imports, 1); assert.equal(out.job.status, 'completed')
  assert.equal(out.calls.filter(call => call.name === 'browser_inspect_element').length, 3, 'fallback identity context stays compatible and attachment input is freshly inspected')
})

test('historical enriched identity key still blocks reimport when snapshot already contains the name', async () => {
  const { createHash } = await import('node:crypto')
  const identity = 'Casey Casey 研究成果 Casey 独立候选人履历'
  const key = createHash('sha256').update(`liepin:${identity}`).digest('hex').slice(0, 32)
  const out = await fixture([[snapshot], [select], request => {
    assert.match(JSON.stringify(request.messages), /RESUME_CANDIDATE_ALREADY_PROCESSED/)
    return [finish]
  }], { page: n => ({ ...page(n), format: 'semantic' }),
    inspect: (args, n) => ({ item: { ...page(n).items.find(item => item.ref === args.ref), context: { text: 'Casey 独立候选人履历' } } }),
    priorJobs: [{ id: 'prior', platform: 'liepin', results: [{ key, name: 'Casey', stage: 'succeeded' }] }] })
  assert.equal(out.error, undefined); assert.equal(out.imports, 0); assert.equal(out.job.results.length, 0)
})

test('complete legacy card identity avoids redundant candidate inspection but not attachment validation', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1')]], {
    page: n => { const p = page(n); p.format = 'semantic'; p.items[0] = { ref: 'candidate', role: 'button', name: 'Casey 30岁 本科 8年经验' }; return p },
  })
  assert.equal(out.error, undefined); assert.equal(out.imports, 1)
  const inspections = out.calls.filter(call => call.name === 'browser_inspect_element')
  assert.deepEqual(inspections.map(call => call.args.ref), ['attachment'])
})

test('hidden, invisible and modal-background identities remain ineligible and failures explain the offending ref', async () => {
  for (const state of ['hidden', 'invisible', 'blocked_by_dialog']) {
    const out = await fixture([[snapshot], [select], request => {
      const errors = request.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result' && block.isError)
      const result = JSON.parse(errors.at(-1).content[0].text)
      assert.match(result.error.message, /CANDIDATE_EVIDENCE_UNREADABLE.*candidate/)
      assert.deepEqual(result.recovery.evidence[0].states, [state])
      return [finish]
    }], { page: n => { const p = page(n); p.format = 'semantic'; p.items[0].states = [state]; return p } })
    assert.equal(out.imports, 0); assert.equal(out.job.results.length, 0)
  }
})

test('an attachment section is rejected before dispatch rather than retried as an occluded download', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1')], request => {
    assert.match(JSON.stringify(request.messages), /RESUME_ATTACHMENT_CONTROL_REQUIRED/)
    return [{ name: 'task_skip_candidate', args: { reason: '需要实际下载按钮' } }]
  }], { page: number => {
    const observed = page(number)
    observed.items[1].role = 'section'
    observed.items[1].states = ['occluded']
    return observed
  } })
  assert.equal(out.error, undefined)
  assert.equal(out.imports, 0)
  assert.equal(out.job.results[0].stage, 'skipped')
})

test('an occluded attachment still cannot dispatch acquisition or upload', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1')], request => {
    assert.match(JSON.stringify(request.messages), /ELEMENT_OCCLUDED/)
    return [{ name: 'task_skip_candidate', args: { reason: '附件入口不可执行' } }]
  }], { page: n => { const p = page(n); p.format = 'semantic'; p.items[1].states = ['occluded']; return p } })
  assert.equal(out.error, undefined); assert.equal(out.imports, 0); assert.equal(out.job.results[0].stage, 'skipped')
})

test('foreign candidate evidence cannot establish identity even when it is readable', async () => {
  const out = await fixture([[snapshot], [{ ...select, args: { ...select.args, name: 'Another person' } }], request => {
    assert.match(JSON.stringify(request.messages), /CANDIDATE_EVIDENCE_INVALID/); return [finish]
  }], { page: n => ({ ...page(n), format: 'semantic' }) })
  assert.equal(out.imports, 0); assert.equal(out.job.results.length, 0)
})

test('startup observation plus navigation observation completes a semantic import in two model turns', async () => {
  const out = await fixture([request => {
    // 宿主种子只能以 user 轮次的「宿主事实」出现：伪造成 assistant 轮次会让思考模式
    // 的请求因缺少 thinking 被 INVALID_REQUEST 拒绝。
    assert.match(JSON.stringify(request.messages), /宿主已执行的浏览器调用与结果/)
    assert.match(JSON.stringify(request.messages), /browser_list_tabs/)
    assert.ok(!request.messages.some(message => message.role === 'assistant'
      && !message.source?.replayState && message.content.some(block => block.type === 'tool-call' && String(block.id).startsWith('host-startup-'))))
    return [select, { name: 'browser_navigate', args: { tabId: 1, url: `${origin}/detail` } }]
  }, request => {
    const results = request.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
    assert.equal(JSON.parse(results.at(-1).content[0].text).snapshot.snapshotId, 's2')
    return [ingest()]
  }], { startupTabs: [{ tabId: 1, url: `${origin}/opaque` }], page: n => ({ ...page(n), format: 'semantic' }),
    infos: [info('browser_navigate', false, { tabId: properties.tabId, url: { type: 'string' } })] })
  assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.imports, 1)
  assert.equal(out.requests.length, 2)
  assert.deepEqual(out.calls.map(call => call.name), ['browser_list_tabs', 'browser_snapshot', 'browser_inspect_element', 'browser_navigate', 'browser_snapshot', 'browser_inspect_element'])
})

test('task selection itself refreshes an expired ref without an extra model snapshot round', async () => {
  const out = await fixture([[snapshot], [{ ...select, args: { ...select.args, snapshotId: 'obsolete' } }], request => {
    const results = request.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
    assert.equal(JSON.parse(results.at(-1).content[0].text).recovery.snapshot.snapshotId, 's2')
    return [{ ...select, args: { ...select.args, snapshotId: 's2' } }, ingest()]
  }])
  assert.equal(out.error, undefined); assert.equal(out.imports, 1); assert.equal(out.requests.length, 3)
})

test('new snapshots and refs cannot reset repeated candidate identity failure', async () => {
  const steps = []
  for (let n = 1; n <= 3; n++) {
    steps.push([snapshot], [{ ...select, args: { ...select.args, snapshotId: `s${n}`, ref: `candidate-${n}`, name: 'Unrelated' } }])
  }
  const out = await fixture(steps, { page: n => { const p = page(n); p.items[0].ref = `candidate-${n}`; return p } })
  assert.match(String(out.error), /BROWSER_AGENT_REPEATED_FAILURE/)
  assert.equal(out.requests.length, 6); assert.equal(out.imports, 0); assert.equal(out.job.results.length, 0)
})

test('ordinary native tool failure returns to the same model loop for a new decision', async () => {
  const out = await fixture([[snapshot], [select, navigate], request => {
    assert.match(JSON.stringify(request.messages), /ELEMENT_OCCLUDED/)
    const error = request.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result' && block.isError)
    assert.equal(JSON.parse(error.content[0].text).recovery.snapshot.snapshotId, 's2')
    return [ingest()]
  }], { navigationError: 'ELEMENT_OCCLUDED' })
  assert.equal(out.error, undefined); assert.equal(out.imports, 1)
  assert.equal(out.requests.length, 3)
})

test('a confirmed capture failure may be replanned without selecting or clicking the person again', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1')], request => {
    assert.match(JSON.stringify(request.messages), /FILE_RESPONSE_NOT_ATTACHMENT/)
    return [snapshot]
  }, [ingest()]], { captureError: 'FILE_RESPONSE_NOT_ATTACHMENT' })
  assert.equal(out.error, undefined); assert.equal(out.imports, 2); assert.equal(out.job.results.length, 1)
})

test('unknown upload outcome ends execution before any reimport or skip', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1'), { name: 'task_skip_candidate', args: { reason: 'retry elsewhere' } }, ingest('s1')]], { outcome: 'unknown' })
  assert.match(String(out.error), /RESUME_IMPORT_OUTCOME_UNKNOWN/)
  assert.equal(out.job.status, 'unknown'); assert.equal(out.job.results[0].stage, 'unknown'); assert.equal(out.imports, 1)
})

test('an exception during upload is uncertain even if its message lacks an uncertainty code', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1'), ingest('s1')]], { importingError: 'server disconnected' })
  assert.match(String(out.error), /RESUME_IMPORT_OUTCOME_UNKNOWN/)
  assert.equal(out.job.results[0].stage, 'unknown'); assert.equal(out.imports, 1)
})

test('historical unknown receipts block reselection without blocking unrelated browser observation', async () => {
  const out = await fixture([[snapshot], [select], request => {
    assert.match(JSON.stringify(request.messages), /RESUME_CANDIDATE_ALREADY_PROCESSED/)
    return [finish]
  }], { priorJobs: [{ id: 'other', platform: 'liepin', results: [{ key: 'old-key', name: 'Casey', stage: 'unknown' }] }] })
  assert.equal(out.error, undefined); assert.equal(out.imports, 0); assert.equal(out.job.status, 'stopped')
})

test('resume authorization rejects platform business writes before transport', async () => {
  const out = await fixture([[snapshot], [{ ...navigate, args: { ...navigate.args, purpose: 'business_write' } }], request => {
    assert.match(JSON.stringify(request.messages), /RESUME_BROWSER_WRITE_NOT_AUTHORIZED/)
    return [finish]
  }])
  assert.equal(out.error, undefined)
  assert.deepEqual(out.calls.map(call => call.name), ['browser_snapshot'])
})

test('runner budget or stopped return cannot silently complete an unfinished resume task', async () => {
  for (const status of ['budget', 'stopped']) {
    const out = await fixture([], { agent: async () => ({ status, message: `fixture_${status}`, turns: 0, modelMs: 0, toolMs: 0 }) })
    assert.match(String(out.error), new RegExp(`fixture_${status}`)); assert.equal(out.job.status, 'running')
  }
})

test('an unexplained ingestion return is not a successful or retryable receipt', async () => {
  const out = await fixture([[snapshot], [select], [ingest('s1'), ingest('s1')]], { outcome: 'sending' })
  assert.match(String(out.error), /RESUME_IMPORT_OUTCOME_UNKNOWN/); assert.equal(out.imports, 1)
  assert.equal(out.job.results[0].stage, 'unknown')
})

test('restarting a persisted pending import cannot satisfy the limit or release uncertainty', async () => {
  const out = await fixture([], { initialResults: [{ key: 'pending', name: 'Casey', stage: 'sending', detail: 'pending', updatedAt: '2026-10-16T00:00:00Z' }] })
  assert.match(String(out.error), /RESUME_IMPORT_OUTCOME_UNKNOWN/)
  assert.equal(out.job.status, 'unknown'); assert.equal(out.job.results[0].stage, 'unknown')
  assert.equal(out.requests.length, 0); assert.equal(out.imports, 0)
})

test('adapter exposes status and task goals without installing a page flow', async () => {
  const out = await fixture([[{ name: 'task_status', args: {} }, finish]], { goal: { entryUrl: `${origin}/entry`, targetJob: 'opaque job' } })
  assert.equal(out.error, undefined)
  assert.match(JSON.stringify(out.requests[0].messages), /opaque job/)
  assert.match(JSON.stringify(out.requests[0].messages), /entryUrl/)
  assert.deepEqual(out.calls, [])
})

test('production resume entry uses the shared Agent adapter', async () => {
  const source = await readFile(new URL('../src/lib/resume-import.ts', import.meta.url), 'utf8')
  assert.match(source, /await runResumeAgent\(/)
  assert.doesNotMatch(source, /await navigateResumes\(/)
})
