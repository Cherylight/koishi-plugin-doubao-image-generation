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

async function loadTypescriptModule(sourcePath) {
  const ts = await loadTypescript()
  const source = await readFile(sourcePath, 'utf8')
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

const mod = await loadTypescriptModule('src/generation-controller.ts')
const requestOptions = await loadTypescriptModule('src/request-options.ts')
const chatlunaToolResult = await loadTypescriptModule('src/chatluna-tool-result.ts')

const baseRequestOptions = {
  apiType: 'ark',
  modelId: 'doubao-seedream-5-0-pro-260000',
  size: '2K',
  generationCount: 1,
  quality: 'auto',
  sequential: 'disabled',
  sequentialMaxImages: 15,
  layerDecomposition: false,
  transparentBackground: false,
  optimizePromptMode: 'standard',
  watermark: false,
  responseFormat: 'b64_json',
  enableWebSearch: false,
}

const scenarios = [
  await runScenario('ChatLuna tool description enforces ordered delivery and private failures', async () => {
    const description = chatlunaToolResult.buildChatlunaToolDescription('Generate an image.')
    assert.match(description, /waits until image generation finishes/)
    assert.match(description, /images were already delivered/)
    assert.match(description, /no plugin error notice was sent to the user/)
    assert.match(description, /content_policy_violation/)
    assert.match(description, /upstream_quota_exhausted/)
    return { protocolAppended: true }
  }),

  await runScenario('Upstream insufficient quota takes precedence over HTTP 429 rate limiting', async () => {
    const result = chatlunaToolResult.classifyImageGenerationError({
      code: 'insufficient_quota',
      type: 'insufficient_quota',
      message: 'no available image quota',
      httpStatus: 429,
    })
    assert.equal(result.category, 'upstream_quota_exhausted')
    assert.equal(result.retryable, false)
    assert.match(result.suggestedAction, /Do not retry/)
    return result
  }),

  await runScenario('Content policy failures recommend one safely revised retry', async () => {
    const result = chatlunaToolResult.classifyImageGenerationError({
      code: 'content_policy_violation',
      message: 'Prompt was rejected by the safety system',
      httpStatus: 400,
    })
    assert.equal(result.category, 'content_policy_violation')
    assert.equal(result.retryable, true)
    assert.match(result.suggestedAction, /retry once/)
    return result
  }),

  await runScenario('OpenAI compatible text-to-image uses generations with independent fields', async () => {
    const options = {
      ...baseRequestOptions,
      apiType: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8000/v1/',
      modelId: 'gpt-image-2',
      size: '1024x1024',
      generationCount: 3,
      quality: 'high',
      sequential: 'auto',
      sequentialMaxImages: 15,
      layerDecomposition: true,
      transparentBackground: true,
      optimizePromptMode: 'fast',
      watermark: true,
      enableWebSearch: true,
    }
    const payload = { prompt: 'minimal poster' }
    const body = requestOptions.buildImageGenerationBody(options, payload)
    assert.deepEqual(body, {
      model: 'gpt-image-2',
      prompt: 'minimal poster',
      n: 3,
      size: '1024x1024',
      quality: 'high',
      response_format: 'b64_json',
    })
    assert.equal(requestOptions.resolveImageEndpoint(options, payload), 'http://127.0.0.1:8000/v1/images/generations')
    return { endpoint: requestOptions.resolveImageEndpoint(options, payload), body }
  }),

  await runScenario('OpenAI compatible image-to-image uses edits with multipart file uploads', async () => {
    const options = {
      ...baseRequestOptions,
      apiType: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8000/v1/images/generations',
      modelId: 'gpt-image-2',
      size: '1024x1024',
      generationCount: 1,
      quality: 'auto',
    }
    const payload = {
      prompt: 'change the color',
      images: [
        `data:image/png;base64,${Buffer.from('first-image').toString('base64')}`,
        `data:image/jpeg;base64,${Buffer.from('second-image').toString('base64')}`,
      ],
    }
    const body = requestOptions.buildImageGenerationBody(options, payload)
    assert.equal('image' in body, false)
    const form = requestOptions.buildOpenAICompatibleEditFormData(options, payload)
    assert.equal(form.get('prompt'), 'change the color')
    assert.equal(form.get('model'), 'gpt-image-2')
    assert.equal(form.getAll('image').length, 2)
    assert.deepEqual(form.getAll('image').map((file) => [file.name, file.type]), [
      ['image-1.png', 'image/png'],
      ['image-2.jpg', 'image/jpeg'],
    ])
    assert.equal(requestOptions.resolveImageEndpoint(options, payload), 'http://127.0.0.1:8000/v1/images/edits')
    return {
      endpoint: requestOptions.resolveImageEndpoint(options, payload),
      contentType: 'multipart/form-data',
      imageFiles: form.getAll('image').map((file) => [file.name, file.type]),
    }
  }),

  await runScenario('OpenAI compatible edits reject unprepared source URLs', async () => {
    const options = {
      ...baseRequestOptions,
      apiType: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8000/v1',
      modelId: 'gpt-image-2',
      size: 'auto',
    }
    assert.throws(() => requestOptions.buildOpenAICompatibleEditFormData(options, {
      prompt: 'edit',
      images: ['https://multimedia.nt.qq.com.cn/download?temporary=1'],
    }), /拒绝向兼容端点透传原始图片链接/)
    return { rejectedRawUrl: true }
  }),

  await runScenario('OpenAI compatible generation count is limited to one through four', async () => {
    const options = {
      ...baseRequestOptions,
      apiType: 'openai-compatible',
      modelId: 'gpt-image-2',
      size: '1024x1024',
      quality: 'auto',
    }
    assert.throws(() => requestOptions.buildImageGenerationBody({ ...options, generationCount: 0 }, { prompt: 'x' }), /1～4/)
    assert.throws(() => requestOptions.buildImageGenerationBody({ ...options, generationCount: 5 }, { prompt: 'x' }), /1～4/)
    return { rejected: [0, 5] }
  }),

  await runScenario('5.0 pro layer decomposition builds a layer-only request', async () => {
    const body = requestOptions.buildImageGenerationBody({
      ...baseRequestOptions,
      size: 'auto',
      layerDecomposition: true,
    }, { prompt: '', images: ['data:image/png;base64,AAAA'] })
    assert.equal(body.layer_decomposition, true)
    assert.equal(body.size, 'auto')
    assert.equal(body.image, 'data:image/png;base64,AAAA')
    assert.equal('prompt' in body, false)
    assert.equal('sequential_image_generation' in body, false)
    return body
  }),

  await runScenario('layer decomposition and sequential mode are rejected together', async () => {
    assert.throws(() => requestOptions.buildImageGenerationBody({
      ...baseRequestOptions,
      size: 'auto',
      layerDecomposition: true,
      sequential: 'auto',
    }, { prompt: '', images: ['data:image/png;base64,AAAA'] }), /互斥/)
    return { rejected: true }
  }),

  await runScenario('transparent mode forces png and requires one input image', async () => {
    const options = { ...baseRequestOptions, transparentBackground: true }
    assert.throws(() => requestOptions.buildImageGenerationBody(options, { prompt: 'edit', images: [] }), /仅支持输入 1 张/)
    const body = requestOptions.buildImageGenerationBody(options, {
      prompt: 'edit',
      images: ['data:image/png;base64,AAAA'],
    })
    assert.equal(body.background, 'transparent')
    assert.equal(body.output_format, 'png')
    assert.equal('sequential_image_generation' in body, false)
    return body
  }),

  await runScenario('size strings are validated against model limits at runtime', async () => {
    assert.equal(requestOptions.validateImageSize(baseRequestOptions.modelId, '2048x1024', false), '2048x1024')
    assert.throws(() => requestOptions.validateImageSize(baseRequestOptions.modelId, '512x512', false), /总像素/)
    assert.throws(() => requestOptions.validateImageSize(baseRequestOptions.modelId, '4K', false), /不适用于/)
    assert.equal(requestOptions.validateImageSize('doubao-seedream-4-5-251128', '3750x1250', false), '3750x1250')
    return { valid: ['2048x1024', '3750x1250'], rejected: ['512x512', '4K for 5.0 pro'] }
  }),

  await runScenario('5.0 lite keeps sequential mode and web search fields', async () => {
    const body = requestOptions.buildImageGenerationBody({
      ...baseRequestOptions,
      modelId: 'doubao-seedream-5-0-lite-260000',
      size: '3K',
      sequential: 'auto',
      sequentialMaxImages: 4,
      enableWebSearch: true,
    }, { prompt: 'four scenes' })
    assert.equal(body.sequential_image_generation, 'auto')
    assert.deepEqual(body.sequential_image_generation_options, { max_images: 4 })
    assert.deepEqual(body.tools, [{ type: 'web_search' }])
    return body
  }),

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
