import { Buffer } from 'node:buffer'

export type SeedreamModelFamily = '5.0-pro' | '5.0-lite' | '4.5' | '4.0' | 'unknown'

export interface ImageRequestOptions {
  apiType: 'ark' | 'openai-compatible'
  modelId: string
  size: string
  generationCount: number
  quality: string
  sequential: string
  sequentialMaxImages: number
  layerDecomposition: boolean
  transparentBackground: boolean
  optimizePromptMode: string
  watermark: boolean
  responseFormat: string
  enableWebSearch: boolean
}

export interface ImageRequestPayload {
  prompt: string
  images?: string[]
}

interface SizeRule {
  tiers: string[]
  minPixels: number
  maxPixels: number
}

const GENERATION_SIZE_RULES: Record<Exclude<SeedreamModelFamily, 'unknown'>, SizeRule> = {
  '5.0-pro': { tiers: ['1K', '1.5K', '2K'], minPixels: 921_600, maxPixels: 4_624_220 },
  '5.0-lite': { tiers: ['2K', '3K', '4K'], minPixels: 3_686_400, maxPixels: 16_777_216 },
  '4.5': { tiers: ['2K', '4K'], minPixels: 3_686_400, maxPixels: 16_777_216 },
  '4.0': { tiers: ['1K', '2K', '4K'], minPixels: 921_600, maxPixels: 16_777_216 },
}

const ALL_TIERS = ['1K', '1.5K', '2K', '3K', '4K']

export function getSeedreamModelFamily(modelId: string): SeedreamModelFamily {
  const normalized = String(modelId || '').toLowerCase()
  if (normalized.includes('seedream-5-0-pro')) return '5.0-pro'
  if (normalized.includes('seedream-5-0')) return '5.0-lite'
  if (normalized.includes('seedream-4-5')) return '4.5'
  if (normalized.includes('seedream-4-0')) return '4.0'
  return 'unknown'
}

function validatePixelSize(size: string, rule: SizeRule) {
  const matched = size.match(/^(\d+)x(\d+)$/)
  if (!matched) return false
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`图像尺寸 ${size} 无效：宽高必须是正整数`)
  }
  const pixels = width * height
  const ratio = width / height
  if (pixels < rule.minPixels || pixels > rule.maxPixels) {
    throw new Error(`图像尺寸 ${size} 无效：总像素必须在 [${rule.minPixels}, ${rule.maxPixels}] 范围内`)
  }
  if (ratio < 1 / 16 || ratio > 16) {
    throw new Error(`图像尺寸 ${size} 无效：宽高比必须在 [1/16, 16] 范围内`)
  }
  return true
}

export function validateImageSize(modelId: string, rawSize: string, layerDecomposition: boolean): string {
  const size = String(rawSize ?? '').trim()
  if (!size) throw new Error('图像尺寸不能为空')

  if (layerDecomposition) {
    const allowed = ['auto', '1K', '1.5K', '2K']
    if (!allowed.includes(size)) {
      throw new Error(`图层拆分模式的图像尺寸仅支持 ${allowed.join('、')}，当前值为 ${size}`)
    }
    return size
  }

  const family = getSeedreamModelFamily(modelId)
  if (family === 'unknown') {
    if (ALL_TIERS.includes(size)) return size
    const genericRule: SizeRule = { tiers: ALL_TIERS, minPixels: 1, maxPixels: Number.MAX_SAFE_INTEGER }
    if (validatePixelSize(size, genericRule)) return size
    throw new Error(`图像尺寸 ${size} 格式无效：请输入分辨率档位（如 2K）或宽x高像素值（如 2048x1024）`)
  }

  const rule = GENERATION_SIZE_RULES[family]
  if (rule.tiers.includes(size)) return size
  if (validatePixelSize(size, rule)) return size
  throw new Error(`图像尺寸 ${size} 不适用于 Seedream ${family}：可用档位为 ${rule.tiers.join('、')}，或输入符合该模型限制的宽x高像素值`)
}

function requireProFeature(modelId: string, feature: string) {
  const family = getSeedreamModelFamily(modelId)
  if (family !== 'unknown' && family !== '5.0-pro') {
    throw new Error(`${feature}仅支持 Seedream 5.0 Pro，当前模型为 Seedream ${family}`)
  }
}

export function validateRuntimeRequest(options: ImageRequestOptions, payload: ImageRequestPayload): string {
  const imageCount = payload.images?.length || 0
  const prompt = String(payload.prompt || '').trim()

  if (options.apiType === 'openai-compatible') {
    if (!prompt) throw new Error('OpenAI 兼容图片接口必须提供提示词')
    const count = Number(options.generationCount)
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
      throw new Error(`OpenAI 兼容图片接口生成数量必须是 1～4，当前值为 ${options.generationCount}`)
    }
    const size = String(options.size ?? '').trim()
    if (!size) throw new Error('OpenAI 兼容图片接口的图像尺寸不能为空')
    return size
  }

  if (options.layerDecomposition && options.sequential === 'auto') {
    throw new Error('图层拆分模式与组图模式互斥，请关闭其中一个开关')
  }
  if (options.layerDecomposition && options.transparentBackground) {
    throw new Error('图层拆分模式已经输出透明 PNG 图层，不能同时开启图片透明通道')
  }
  if (options.transparentBackground && options.sequential === 'auto') {
    throw new Error('图片透明通道仅支持单图生成，不能同时开启组图模式')
  }

  if (options.layerDecomposition) {
    requireProFeature(options.modelId, '图层拆分模式')
    if (imageCount !== 1) throw new Error('图层拆分模式必须且只能输入 1 张图片')
  } else if (!prompt) {
    throw new Error('图片生成模式必须提供提示词')
  }

  if (options.transparentBackground) {
    requireProFeature(options.modelId, '图片透明通道')
    if (imageCount !== 1) throw new Error('图片透明通道仅支持输入 1 张带透明通道的图片进行图生图')
  }

  if (getSeedreamModelFamily(options.modelId) === '5.0-pro' && options.sequential === 'auto') {
    throw new Error('Seedream 5.0 Pro 不支持组图模式，请关闭组图开关')
  }

  return validateImageSize(options.modelId, options.size, options.layerDecomposition)
}

export function buildImageGenerationBody(options: ImageRequestOptions, payload: ImageRequestPayload): Record<string, any> {
  const size = validateRuntimeRequest(options, payload)
  const prompt = String(payload.prompt || '').trim()

  if (options.apiType === 'openai-compatible') {
    return {
      model: options.modelId,
      prompt,
      n: options.generationCount,
      size,
      quality: options.quality,
      response_format: options.responseFormat,
    }
  }

  const family = getSeedreamModelFamily(options.modelId)
  const body: Record<string, any> = {
    model: options.modelId,
    size,
    optimize_prompt_options: { mode: options.optimizePromptMode },
    watermark: options.watermark,
    response_format: options.responseFormat,
    stream: false,
  }

  if (prompt) body.prompt = prompt
  if (payload.images?.length) {
    body.image = payload.images.length === 1 ? payload.images[0] : payload.images
  }

  if (options.layerDecomposition) {
    body.layer_decomposition = true
  } else if (family !== '5.0-pro') {
    body.sequential_image_generation = options.sequential
    if (options.sequential === 'auto') {
      body.sequential_image_generation_options = { max_images: options.sequentialMaxImages }
    }
  }

  if (options.transparentBackground) {
    body.background = 'transparent'
    body.output_format = 'png'
  }

  if (options.enableWebSearch && family === '5.0-lite') {
    body.tools = [{ type: 'web_search' }]
  }
  return body
}

export function buildOpenAICompatibleEditFormData(
  options: ImageRequestOptions,
  payload: ImageRequestPayload,
): FormData {
  if (options.apiType !== 'openai-compatible' || !payload.images?.length) {
    throw new Error('仅 OpenAI 兼容图片编辑请求可以构建 multipart 表单')
  }

  const fields = buildImageGenerationBody(options, payload)
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value))
  }

  payload.images.forEach((source, index) => {
    const matched = String(source || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/)
    if (!matched) {
      throw new Error(`第 ${index + 1} 张参考图尚未转换为本地文件，拒绝向兼容端点透传原始图片链接`)
    }
    const mime = matched[1].toLowerCase()
    const buffer = Buffer.from(matched[2], 'base64')
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1].replace(/[^a-z0-9]+/g, '') || 'bin'
    const blob = new Blob([new Uint8Array(buffer)], { type: mime })
    form.append('image', blob, `image-${index + 1}.${extension}`)
  })
  return form
}

export function resolveImageEndpoint(options: ImageRequestOptions & { endpoint: string }, payload: ImageRequestPayload): string {
  if (options.apiType === 'ark') return options.endpoint

  const baseURL = String(options.endpoint || '').trim().replace(/\/+$/, '')
  if (!baseURL) throw new Error('OpenAI 兼容接口 Base URL 不能为空')
  const normalizedBase = baseURL.replace(/\/images\/(?:generations|edits)$/i, '')
  const operation = payload.images?.length ? 'edits' : 'generations'
  return `${normalizedBase}/images/${operation}`
}
