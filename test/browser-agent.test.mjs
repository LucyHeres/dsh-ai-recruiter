import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Compile only this new core, so these tests do not require a full project build.
const source = await readFile(new URL('../src/lib/browser-agent.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const errorsSource = await readFile(new URL('../src/lib/browser-errors.ts', import.meta.url), 'utf8')
const errorsCompiled = ts.transpileModule(errorsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const errorsUrl = `data:text/javascript;base64,${Buffer.from(errorsCompiled).toString('base64')}`
const contextSource = ts.transpileModule(await readFile(new URL('../src/lib/llm-message-source.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const contextUrl = `data:text/javascript;base64,${Buffer.from(contextSource).toString('base64')}`
const moduleSource = compiled.replace(/from ['"]@deepseek-ai\/dsh-llm['"]/g, `from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm'))}`)
  .replace(/from ['"]\.\/browser-errors\.js['"]/g, `from ${JSON.stringify(errorsUrl)}`)
  .replace(/from ['"]\.\/llm-message-source\.js['"]/g, `from ${JSON.stringify(contextUrl)}`)
const { runBrowserAgent } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)
const route = { provider: 'host-test', model: 'specific-default', reasoningEffort: 'high' }
const call = (id, name, args = {}) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const text = value => ({ type: 'text', text: value })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const replies = request => request.messages.filter(message => message.role === 'tool')
function model(turns) {
  const requests = []
  return { requests, async *stream(options) {
    requests.push(structuredClone({ ...options, signal: undefined }))
    const next = turns.shift()
    assert.ok(next, 'Unexpected model turn')
    if (next instanceof Error) throw next
    const blocks = typeof next === 'function' ? await next(options) : next
    for (let index = 0; index < blocks.length; index++) {
      yield { type: 'block-start', index, blockType: blocks[index].type }
      yield { type: 'block-end', index, block: blocks[index] }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  } }
}
function tool(name, execute, readOnly = false, inputSchema = { type: 'object', additionalProperties: false }) {
  return { name, description: `Test native tool ${name}`, inputSchema, readOnly, execute }
}
function options(tools, extra = {}) {
  return { system: 'Follow the supplied goal.', goal: { target: 'goal-one' }, tools,
    signal: new AbortController().signal, maxTurns: 10, maxDurationMs: 5000, ...extra }
}

test('raw images require host admission and cannot silently become a text-only request', async () => {
  const llm = model([])
  const output = await runBrowserAgent(llm, route, options([], {
    inputImages: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
  }))
  assert.equal(output.status, 'stopped')
  assert.match(output.message, /BROWSER_AGENT_IMAGE_ADMISSION_REQUIRED/)
  assert.equal(llm.requests.length, 0)
})

test('actual native schemas and route pass through; a new ordinary error returns to the model to choose another path', async () => {
  let complete = false
  const executed = [], schema = { type: 'object', properties: { invented: { type: 'string' } }, required: ['invented'] }
  const llm = model([[call('first', 'browser_unseen_action', { invented: 'a' })], [call('alternative', 'browser_new_path', { invented: 'b' })]])
  const output = await runBrowserAgent(llm, route, options([
    tool('browser_unseen_action', async args => { executed.push(args); throw new Error('NEW_SITE_BEHAVIOR: evidence changed') }, false, schema),
    tool('browser_new_path', async args => { executed.push(args); complete = true; return { receipt: 'verified' } }, false, schema)
  ], { isComplete: () => complete }))
  assert.equal(output.status, 'completed'); assert.equal(output.turns, 2)
  assert.deepEqual(executed, [{ invented: 'a' }, { invented: 'b' }])
  assert.deepEqual(llm.requests[0].tools[0].parameters, schema)
  assert.equal(llm.requests[0].tools[0].name, 'browser_unseen_action')
  assert.equal(llm.requests[0].model, route.model); assert.equal(llm.requests[0].provider, route.provider)
  assert.equal(llm.requests[0].reasoningEffort, 'high')
  assert.match(replies(llm.requests[1])[0].content[0].text, /NEW_SITE_BEHAVIOR/)
  assert.equal(replies(llm.requests[1])[0].isError, true)
})

test('fatal uncertain writes stop the remaining tool calls and never ask the model to replay', async () => {
  const executed = [], llm = model([[call('first', 'browser_click'), call('second', 'browser_click')]])
  const output = await runBrowserAgent(llm, route, options([tool('browser_click', async () => {
    executed.push('click'); throw Object.assign(new Error('RESULT_UNKNOWN'), { code: 'RESULT_UNKNOWN' })
  })], { isFatal: error => error.code === 'RESULT_UNKNOWN' }))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /RESULT_UNKNOWN/)
  assert.deepEqual(executed, ['click']); assert.equal(llm.requests.length, 1)
})

test('read batches run at most three concurrently while writes and host bookkeeping stay ordered', async () => {
  let active = 0, peak = 0, complete = false
  const events = [], llm = model([[call('r1', 'browser_read', { id: 1 }), call('r2', 'browser_read', { id: 2 }), call('r3', 'browser_read', { id: 3 }),
    call('r4', 'browser_read', { id: 4 }), call('record', 'task_record'), call('action', 'browser_click'), call('finish', 'task_finish')]])
  const output = await runBrowserAgent(llm, route, options([
    tool('browser_read', async args => { events.push(`read${args.id}-start`); peak = Math.max(peak, ++active); await wait(8); active--; events.push(`read${args.id}-end`); return args }, true),
    tool('task_record', async () => { assert.equal(active, 0); events.push('record'); return {} }),
    tool('browser_click', async () => { assert.equal(events.at(-1), 'record'); events.push('click'); return { dispatched: true } }),
    tool('task_finish', async () => { events.push('finish'); complete = true; return {} })
  ], { isComplete: () => complete }))
  assert.equal(output.status, 'completed'); assert.equal(output.turns, 1); assert.equal(peak, 3)
  assert.ok(events.indexOf('read4-start') > events.indexOf('read3-end'))
  assert.deepEqual(events.slice(-3), ['record', 'click', 'finish'])
  assert.ok(output.modelMs >= 0 && output.toolMs >= 8)
})

test('a host finish flag ends after the executed result group and skips later writes', async () => {
  let complete = false, clicked = false
  const llm = model([[call('finish', 'task_finish'), call('extra', 'browser_click')]])
  const output = await runBrowserAgent(llm, route, options([
    tool('task_finish', async () => { complete = true; return { confirmed: true } }),
    tool('browser_click', async () => { clicked = true; return {} })
  ], { isComplete: () => complete, maxTurns: 1 }))
  assert.equal(output.status, 'completed'); assert.equal(clicked, false)
})

test('plain text cannot fake completion and receives explicit unfinished feedback', async () => {
  let complete = false
  const llm = model([[text('Everything is complete')], [call('finish', 'task_finish')]])
  const output = await runBrowserAgent(llm, route, options([tool('task_finish', async () => { complete = true; return {} })], { isComplete: () => complete }))
  assert.equal(output.status, 'completed'); assert.equal(output.turns, 2)
  assert.ok(llm.requests[1].messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('completion condition is still false'))))
  const falseFinish = await runBrowserAgent(model([[text('done')]]), route, options([], { maxTurns: 1 }))
  assert.equal(falseFinish.status, 'budget')
})

test('ordinary failure skips dependent tail calls, preserving complete correlated call/result groups', async () => {
  let complete = false, writes = 0
  const llm = model([[call('bad', 'browser_read'), call('dependent', 'browser_click')], [call('finish', 'task_finish')]])
  await runBrowserAgent(llm, route, options([
    tool('browser_read', async () => { throw new Error('UNFAMILIAR_ERROR') }, true),
    tool('browser_click', async () => { writes++; return {} }),
    tool('task_finish', async () => { complete = true; return {} })
  ], { isComplete: () => complete }))
  assert.equal(writes, 0)
  assert.deepEqual(replies(llm.requests[1]).map(reply => reply.toolCallId), ['bad', 'dependent'])
  assert.ok(replies(llm.requests[1]).every(reply => reply.isError))
  assert.match(replies(llm.requests[1])[1].content[0].text, /PREVIOUS_TOOL_FAILED/)
})

test('a newly discovered schema can be used next turn without core changes', async () => {
  let complete = false
  const tools = [tool('discover', async () => {
    tools.push(tool('browser_brand_new_mcp_tool', async args => { assert.equal(args.newField, 7); complete = true; return {} }, false,
      { type: 'object', properties: { newField: { type: 'integer' } }, required: ['newField'] }))
    return { available: ['browser_brand_new_mcp_tool'] }
  }, true)]
  const llm = model([[call('discover', 'discover')], [call('use', 'browser_brand_new_mcp_tool', { newField: 7 })]])
  assert.equal((await runBrowserAgent(llm, route, options(tools, { isComplete: () => complete }))).status, 'completed')
  assert.ok(llm.requests[1].tools.some(value => value.name === 'browser_brand_new_mcp_tool'))
})

test('conversation compaction keeps whole groups and no task shares another task history', async () => {
  let complete = false
  const turns = Array.from({ length: 29 }, (_, i) => [call(`read-${i}`, 'browser_read')])
  turns.push([call('finish', 'task_finish')])
  const llm = model(turns)
  assert.equal((await runBrowserAgent(llm, route, options([
    tool('browser_read', async () => ({ full: 'unchanged output' }), true),
    tool('task_finish', async () => { complete = true; return {} })
  ], { isComplete: () => complete, maxTurns: 32 }))).status, 'completed')
  const last = llm.requests.at(-1), calls = new Set(last.messages.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.id)))
  assert.equal(replies(last).length, 24)
  assert.ok(replies(last).every(reply => calls.has(reply.toolCallId)))
  const other = model([[text('new task')]])
  await runBrowserAgent(other, route, options([], { goal: { target: 'another' }, maxTurns: 1 }))
  assert.equal(replies(other.requests[0]).length, 0)
  assert.ok(!JSON.stringify(other.requests[0]).includes('read-28'))
})

test('context budget stops before sending oversized tool output instead of cutting its content', async () => {
  const llm = model([[call('big', 'browser_read')]])
  const output = await runBrowserAgent(llm, route, options([tool('browser_read', async () => ({ large: 'z'.repeat(250000) }), true)]))
  assert.equal(output.status, 'budget'); assert.match(output.message, /CONTEXT_BUDGET/)
  assert.equal(llm.requests.length, 1)
})

test('cancellation stops a noncooperative model and prevents all tools', async () => {
  const controller = new AbortController()
  let writes = 0
  const llm = { async *stream() { await new Promise(() => {}); yield {} } }
  const pending = runBrowserAgent(llm, route, options([tool('browser_click', async () => { writes++; return {} })], { signal: controller.signal }))
  controller.abort()
  const output = await pending
  assert.equal(output.status, 'stopped'); assert.match(output.message, /CANCELLED/); assert.equal(writes, 0)
})

test('overall duration budget cancels a blocked tool and prevents subsequent writes', async () => {
  let writes = 0
  const llm = model([[call('blocked', 'browser_read'), call('write', 'browser_click')]])
  const output = await runBrowserAgent(llm, route, options([
    tool('browser_read', async () => new Promise(() => {}), true),
    tool('browser_click', async () => { writes++; return {} })
  ], { maxDurationMs: 15 }))
  assert.equal(output.status, 'budget'); assert.match(output.message, /DURATION_BUDGET/); assert.equal(writes, 0)
})

test('unknown tools and invalid JSON args are model-visible errors without dispatch', async () => {
  let complete = false, dispatched = 0
  const malformed = { ...call('bad', 'browser_click'), arguments: '[1,2]' }
  const llm = model([[call('unknown', 'unknown_tool')], [malformed], [call('finish', 'task_finish')]])
  const output = await runBrowserAgent(llm, route, options([
    tool('browser_click', async () => { dispatched++; return {} }),
    tool('task_finish', async () => { complete = true; return {} })
  ], { isComplete: () => complete }))
  assert.equal(output.status, 'completed'); assert.equal(dispatched, 0)
  assert.match(replies(llm.requests[1])[0].content[0].text, /TOOL_NOT_AVAILABLE/)
  assert.match(replies(llm.requests[2]).at(-1).content[0].text, /ARGUMENT_INVALID/)
})

test('a per-model deadline cancels a noncooperative provider without starting tools or retrying', async () => {
  let calls = 0, providerSignal
  const llm = { async *stream(request) { calls++; providerSignal = request.signal; await new Promise(() => {}); yield {} } }
  const output = await runBrowserAgent(llm, route, options([], { modelTurnTimeoutMs: 15 }))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /MODEL_TURN_TIMEOUT/)
  assert.equal(calls, 1); assert.equal(providerSignal.aborted, true)
})

test('three identical failures stop inference loops; object key order cannot bypass the bound', async () => {
  let executed = 0, recovered = 0
  const llm = model([[call('a', 'browser_click', { tabId: 7, ref: 'old' })],
    [call('b', 'browser_click', { ref: 'old', tabId: 7 })], [call('c', 'browser_click', { tabId: 7, ref: 'old' })]])
  const broken = { ...tool('browser_click', async () => { executed++; throw new Error('SNAPSHOT_EXPIRED') }),
    recover: async () => { recovered++; return { snapshot: 'new' } } }
  const output = await runBrowserAgent(llm, route, options([broken]))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /REPEATED_FAILURE/)
  assert.equal(executed, 3); assert.equal(llm.requests.length, 3); assert.equal(recovered, 2)
  assert.match(replies(llm.requests[1])[0].content[0].text, /original action was NOT replayed/)
})

test('successful retry clears its failure streak and distinct arguments remain independent', async () => {
  let tries = 0
  const llm = model(Array.from({ length: 6 }, (_, i) => [call(`c${i}`, 'read', { ref: i < 5 ? 'a' : 'b' })]))
  const output = await runBrowserAgent(llm, route, options([tool('read', async () => {
    if (++tries === 3) return { recovered: true }
    throw new Error('READ_FAILED')
  }, true)], { maxTurns: 6 }))
  assert.equal(output.status, 'budget'); assert.equal(tries, 6)
})

test('host evidence validation can opt into five corrections while unchanged failures remain bounded', async () => {
  for (const succeeds of [true, false]) {
    let tries = 0, complete = false, recoveries = 0
    const llm = model(Array.from({ length: 5 }, (_, i) => [call(`c${i}`, 'record', { ref: `renewed-${i}` })]))
    const record = { ...tool('record', async () => {
      if (++tries === 4 && succeeds) { complete = true; return { saved: true } }
      throw new Error('CANDIDATE_EVIDENCE_INVALID')
    }), failureKey: () => 'same-candidate-and-evidence', maxRecoverableFailures: 5,
    recover: async () => { recoveries++; return { next: 'inspect or skip' } } }
    const output = await runBrowserAgent(llm, route, options([record], { isComplete: () => complete }))
    assert.equal(output.status, succeeds ? 'completed' : 'stopped')
    assert.equal(tries, succeeds ? 4 : 5)
    assert.equal(recoveries, succeeds ? 3 : 4)
    const first = JSON.parse(replies(llm.requests[1])[0].content[0].text)
    assert.deepEqual(first.correctionBudget, { attempts: 1, limit: 5 })
  }
})

test('extra evidence correction budget cannot replay an uncertain write', async () => {
  let tries = 0, recoveries = 0
  const llm = model([[call('write', 'record')]])
  const output = await runBrowserAgent(llm, route, options([{ ...tool('record', async () => {
    tries++; throw Object.assign(new Error('RESULT_UNKNOWN'), { uncertainWrite: true })
  }), maxRecoverableFailures: 5, recover: async () => { recoveries++ } }]))
  assert.equal(output.status, 'stopped'); assert.equal(tries, 1); assert.equal(recoveries, 0)
})

test('uncertain writes never invoke the read-recovery hook or resume model inference', async () => {
  let recovered = 0
  const llm = model([[call('a', 'write')]])
  const output = await runBrowserAgent(llm, route, options([{ ...tool('write', async () => {
    throw Object.assign(new Error('RESULT_UNKNOWN'), { uncertainWrite: true })
  }), recover: async () => { recovered++; return {} } }]))
  assert.equal(output.status, 'stopped'); assert.equal(recovered, 0); assert.equal(llm.requests.length, 1)
})

test('three plain text turns without a tool stop rather than paying for the full turn budget', async () => {
  const llm = model([[text('working')], [text('working')], [text('done')]])
  const output = await runBrowserAgent(llm, route, options([]))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /NO_TOOL_PROGRESS/)
  assert.equal(llm.requests.length, 3)
})

test('timing logs distinguish first stream metadata from first generated content without recording content', async () => {
  const logs = []
  const llm = { async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await wait(10)
    yield { type: 'text-delta', index: 0, text: 'private-page-text' }
    yield { type: 'block-end', index: 0, block: text('private-page-text') }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  await runBrowserAgent(llm, route, options([], { maxTurns: 1, logger: { write: (level, event, fields) => logs.push({ event, fields }) } }))
  const fields = logs.find(row => row.event === 'browser_agent.model_turn').fields
  assert.ok(fields.firstContentMs >= fields.firstChunkMs + 5)
  assert.ok(fields.generationMs >= 0); assert.equal(fields.contextSavedCharacters, 0)
  assert.ok(!JSON.stringify(logs).includes('private-page-text'))
})

test('a failed refresh cannot replace the original action error or trigger an automatic retry', async () => {
  let complete = false, writes = 0
  const llm = model([[call('write', 'write')], [call('finish', 'finish')]])
  const output = await runBrowserAgent(llm, route, options([
    { ...tool('write', async () => { writes++; throw new Error('PAGE_CHANGED') }), recover: async () => { throw new Error('REFRESH_UNAVAILABLE') } },
    tool('finish', async () => { complete = true; return {} }),
  ], { isComplete: () => complete }))
  assert.equal(output.status, 'completed'); assert.equal(writes, 1)
  const error = JSON.parse(replies(llm.requests[1])[0].content[0].text)
  assert.equal(error.error.code, 'PAGE_CHANGED'); assert.equal(error.recovery, undefined)
})

test('cancellation while refreshing a failed observation prevents the next model turn', async () => {
  const abort = new AbortController()
  const llm = model([[call('write', 'write')]])
  const output = await runBrowserAgent(llm, route, options([
    { ...tool('write', async () => { throw new Error('PAGE_CHANGED') }), recover: async () => { abort.abort(); await new Promise(() => {}) } },
  ], { signal: abort.signal }))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /CANCELLED/)
  assert.equal(llm.requests.length, 1)
})

test('a failed practice is listed back to the model so it stops replanning the same attempt', async () => {
  const llm = model([[call('a', 'browser_click', { ref: 'old' })], [call('b', 'browser_click', { ref: 'old' })],
    [call('c', 'browser_click', { ref: 'old' })]])
  const broken = { ...tool('browser_click', async () => { throw new Error('ELEMENT_OCCLUDED') }),
    failureKey: () => 'stable-target', failureLabel: () => 'button#job-switch' }
  const output = await runBrowserAgent(llm, route, options([broken]))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /REPEATED_FAILURE/)
  // 第二次起模型能看到「做法名 + 目标 + 错误码」的失败清单。
  const second = JSON.stringify(llm.requests[1].messages)
  assert.match(second, /已失败做法/)
  assert.match(second, /browser_click → button#job-switch \[ELEMENT_OCCLUDED\] 已失败 1 次/)
  // 稳定身份让三次相同失败被认成同一个目标，因此第三次就停止。
  assert.equal(llm.requests.length, 3)
})

test('model narration is reported as a model-sourced progress line, never as verified fact', async () => {
  const seen = []
  const llm = model([[call('a', 'read', { ref: 'a' })], [text('列表已按目标职位筛选')]])
  const output = await runBrowserAgent(llm, route, options([tool('read', async () => ({ ok: true }), true)],
    { onProgress: async (message, source) => { seen.push({ message, source }) } }))
  assert.equal(output.status, 'stopped')
  assert.deepEqual(seen.filter(entry => entry.source === 'model').map(entry => entry.message), ['列表已按目标职位筛选'])
})

test('an empty model stream is retried once instead of failing the whole task', async () => {
  let attempt = 0, complete = false
  const llm = { async *stream() {
    if (++attempt === 1) return                       // 第一次：流正常结束但没有任何 chunk
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: call('a', 'read', { ref: 'a' }) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  const output = await runBrowserAgent(llm, route, options([
    tool('read', async () => { complete = true; return { ok: true } }, true)], { isComplete: () => complete }))
  assert.equal(attempt, 2, '同一轮内空流只重试一次')
  assert.equal(output.status, 'completed')
})

test('a stream that keeps ending without a finish stops after the bounded retry', async () => {
  let attempt = 0
  const logs = []
  const llm = { async *stream() { attempt++; return } }
  const output = await runBrowserAgent(llm, route, options([], { logger: { write: (_l, event, fields) => logs.push({ event, ...fields }) } }))
  assert.equal(output.status, 'stopped'); assert.match(output.message, /MODEL_INCOMPLETE/)
  assert.equal(attempt, 2, '最多重试一次，不能无限重试')
  const incomplete = logs.filter(row => row.event === 'browser_agent.model_incomplete')
  assert.equal(incomplete.length, 2)
  assert.equal(incomplete.at(-1).chunks, 0)
  assert.equal(incomplete.at(-1).finished, false)
})

test('a provider error finish is surfaced with its real cause and retried once', async () => {
  let attempt = 0
  const logs = []
  const llm = { async *stream() {
    attempt++
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', status: 429, message: 'too many requests' } } }
  } }
  const output = await runBrowserAgent(llm, route, options([], {
    logger: { write: (_l, event, fields) => logs.push({ event, ...fields }) } }))
  assert.equal(attempt, 2, '提供方失败应在同一轮内重试一次')
  assert.match(output.message, /BROWSER_AGENT_MODEL_FAILED/)
  assert.match(output.message, /RATE_LIMITED/)
  assert.match(output.message, /too many requests/)
  const incomplete = logs.filter(row => row.event === 'browser_agent.model_incomplete')
  assert.equal(incomplete.length, 2)
  assert.equal(incomplete[0].finishKind, 'error')
  assert.equal(incomplete[0].failureCode, 'RATE_LIMITED')
  assert.equal(incomplete[0].failureStatus, 429)
})

test('an aborted model stream stops immediately without retrying', async () => {
  let attempt = 0
  const llm = { async *stream() { attempt++; yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'USER_ABORTED', message: 'stopped' } } } } }
  const output = await runBrowserAgent(llm, route, options([]))
  assert.equal(attempt, 1, '取消不应重试')
  assert.equal(output.status, 'stopped')
})

test('host seeds are user-role facts and never fabricated assistant turns', async () => {
  const llm = model([[text('done')]])
  const output = await runBrowserAgent(llm, route, options([tool('read', async () => ({}), true)], {
    initialToolResults: [{ name: 'read', args: { ref: 'a' }, value: { observation: 'first-look' } }],
  }))
  assert.equal(output.status, 'stopped')
  const messages = llm.requests[0].messages
  assert.match(JSON.stringify(messages), /宿主已执行的浏览器调用与结果/)
  assert.match(JSON.stringify(messages), /first-look/)
  // 关键：不能出现「只有工具调用、没有 thinking」的伪造 assistant 轮次。
  const fabricated = messages.filter(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && String(block.id).startsWith('host-startup-')))
  assert.deepEqual(fabricated, [])
})

test('reasoning returned by the model is passed back on the next request', async () => {
  let seen = 0, complete = false
  const llm = model([
    [{ type: 'reasoning', text: 'thinking-about-the-page' }, call('t1', 'read', { ref: 'a' })],
    [call('t2', 'read', { ref: 'b' })],
  ])
  const output = await runBrowserAgent(llm, route, options([
    tool('read', async () => { if (++seen === 2) complete = true; return {} }, true)], { isComplete: () => complete }))
  assert.equal(output.status, 'completed')
  const second = llm.requests[1].messages.find(message => message.role === 'assistant')
  assert.ok(second?.content.some(block => block.type === 'reasoning' && block.text === 'thinking-about-the-page'),
    '思考内容必须原样回传，否则思考模式的请求会被拒绝')
})
