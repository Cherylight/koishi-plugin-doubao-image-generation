import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

async function loadTypescript() {
  try {
    return await import('typescript')
  } catch {
    const require = createRequire(import.meta.url)
    const candidates = [
      process.cwd(),
      'D:/code_base/koishi-app',
    ]
    for (const base of candidates) {
      try {
        const resolved = require.resolve('typescript', { paths: [base] })
        return await import(pathToFileURL(resolved).href)
      } catch {}
    }
    throw new Error('Cannot load typescript. Run dependency installation before npm run test:offline.')
  }
}

async function loadControllerModule() {
  const ts = await loadTypescript()
  const source = await readFile('src/generation-controller.ts', 'utf8')
  const built = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  })
  const code = built.outputText
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

class MemoryQuotaStore {
  constructor(seed = {}) {
    this.row = {
      date: '2026-06-04',
      successCount: 0,
      webSearchCount: 0,
      reservedCount: 0,
      apiRequestedCount: 0,
      apiGeneratedCount: 0,
      messageSentCount: 0,
      sendFailedCount: 0,
      ...seed,
    }
  }

  async getToday() {
    return { ...this.row }
  }

  async saveToday(row) {
    this.row = { ...row }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createFakeGenerator({ delayMs = 0, images = 1 } = {}) {
  const state = { calls: 0 }
  const generate = async () => {
    state.calls += 1
    if (delayMs) await delay(delayMs)
    return {
      data: Array.from({ length: images }, (_, index) => ({
        b64_json: Buffer.from(`fake-image-${index}`).toString('base64'),
      })),
    }
  }
  return { state, generate }
}

function createFakeSender({ fail = false } = {}) {
  const state = { calls: 0, sent: 0 }
  const sendResult = async (result) => {
    state.calls += 1
    if (fail) throw new Error('fake send failure')
    const sent = Array.isArray(result.data) ? result.data.filter((item) => item.b64_json).length : 0
    state.sent += sent
    return sent
  }
  return { state, sendResult }
}

function createHarness(module, seed) {
  const store = new MemoryQuotaStore(seed)
  const quota = new module.QuotaManager(store)
  const controller = new module.GenerationController(quota)
  return { store, controller }
}

async function runScenario(name, fn) {
  try {
    const details = await fn()
    return { name, ok: true, details }
  } catch (error) {
    return { name, ok: false, error: error?.stack || String(error) }
  }
}

const mod = await loadControllerModule()

const scenarios = [
  await runScenario('chatluna daily limit 1 rejects 4 of 5 concurrent calls', async () => {
    const { store, controller } = createHarness(mod)
    const fakeApi = createFakeGenerator({ delayMs: 25 })
    const fakeSender = createFakeSender()
    const calls = Array.from({ length: 5 }, () => controller.run({
      prompt: 'same prompt',
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 1,
      lockKey: 'qq:channel:1000',
      dedupeKey: 'qq:channel:1000:same prompt:chatluna',
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    }))
    const results = await Promise.all(calls)
    assert.equal(fakeApi.state.calls, 1)
    assert.equal(results.filter((item) => item.status === 'ok').length, 1)
    assert.equal(store.row.apiGeneratedCount, 1)
    assert.equal(store.row.reservedCount, 0)
    return { apiCalls: fakeApi.state.calls, statuses: results.map((item) => item.status), usage: store.row }
  }),

  await runScenario('50 concurrent calls do not exceed remaining quota', async () => {
    const { store, controller } = createHarness(mod)
    const fakeApi = createFakeGenerator({ delayMs: 5 })
    const fakeSender = createFakeSender()
    const calls = Array.from({ length: 50 }, (_, index) => controller.run({
      prompt: `prompt-${index}`,
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 10,
      lockKey: `qq:channel:${index}`,
      dedupeKey: `qq:channel:${index}:prompt-${index}:chatluna`,
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    }))
    const results = await Promise.all(calls)
    assert.equal(fakeApi.state.calls, 10)
    assert.equal(results.filter((item) => item.status === 'ok').length, 10)
    assert.equal(store.row.apiGeneratedCount, 10)
    assert.equal(store.row.reservedCount, 0)
    return { apiCalls: fakeApi.state.calls, ok: results.filter((item) => item.status === 'ok').length, usage: store.row }
  }),

  await runScenario('api success and send failure still records generated cost', async () => {
    const { store, controller } = createHarness(mod)
    const fakeApi = createFakeGenerator()
    const fakeSender = createFakeSender({ fail: true })
    const result = await controller.run({
      prompt: 'send fails',
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 5,
      lockKey: 'qq:channel:1000',
      dedupeKey: 'qq:channel:1000:send fails:chatluna',
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    })
    assert.equal(result.status, 'send_failed')
    assert.equal(store.row.apiGeneratedCount, 1)
    assert.equal(store.row.messageSentCount, 0)
    assert.equal(store.row.sendFailedCount, 1)
    assert.equal(store.row.reservedCount, 0)
    return { status: result.status, usage: store.row }
  }),

  await runScenario('standalone and chatluna share one quota budget', async () => {
    const { store, controller } = createHarness(mod)
    const fakeApi = createFakeGenerator()
    const fakeSender = createFakeSender()
    const standalone = await controller.run({
      prompt: 'standalone',
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 1,
      lockKey: 'qq:channel:1000',
      dedupeKey: 'qq:channel:1000:standalone:standalone',
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    })
    const chatluna = await controller.run({
      prompt: 'chatluna',
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 1,
      lockKey: 'qq:channel:1001',
      dedupeKey: 'qq:channel:1001:chatluna:chatluna',
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    })
    assert.equal(standalone.status, 'ok')
    assert.equal(chatluna.status, 'quota_exceeded')
    assert.equal(fakeApi.state.calls, 1)
    return { statuses: [standalone.status, chatluna.status], apiCalls: fakeApi.state.calls, usage: store.row }
  }),

  await runScenario('same prompt in the same session is deduped within ttl', async () => {
    const { store, controller } = createHarness(mod)
    const fakeApi = createFakeGenerator()
    const fakeSender = createFakeSender()
    const request = {
      prompt: 'repeat',
      responseFormat: 'b64_json',
      quotaUnits: 1,
      dailyLimit: 5,
      lockKey: 'qq:channel:1000',
      dedupeKey: 'qq:channel:1000:repeat:chatluna',
      generate: fakeApi.generate,
      sendResult: fakeSender.sendResult,
    }
    const first = await controller.run(request)
    const second = await controller.run(request)
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'duplicate')
    assert.equal(fakeApi.state.calls, 1)
    assert.equal(store.row.apiGeneratedCount, 1)
    return { statuses: [first.status, second.status], apiCalls: fakeApi.state.calls, usage: store.row }
  }),
]

const failed = scenarios.filter((item) => !item.ok)
for (const scenario of scenarios) {
  console.log(`${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.name}`)
  if (!scenario.ok) console.log(scenario.error)
}
console.log(JSON.stringify({ ok: failed.length === 0, scenarios }, null, 2))

if (failed.length) {
  process.exitCode = 1
}
