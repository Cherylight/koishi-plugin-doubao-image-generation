import { Context } from 'koishi'
import './types'
import {
  logger, normalizeApiError, detectImageMeta, getImageRulesByModel,
  asDataUri, translateErrorCode, buildDetailMessage, DAILY_USAGE_TABLE, todayKey, keepFromDateKey,
} from './utils'
import type { Config, OpenAICompatibleConfig, ImageSize, OptimizePromptMode } from './config'
import {
  buildImageGenerationBody, buildOpenAICompatibleEditFormData, resolveImageEndpoint,
} from './request-options'
import type { DailyUsageSnapshot, QuotaStore } from './generation-controller'
import { normalizeUsageRow } from './generation-controller'

// ── Database helpers ──

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
let lastUsageCleanupAt = 0

export async function cleanupOldUsageRows(ctx: Context, force = false) {
  const now = Date.now()
  if (!force && now - lastUsageCleanupAt < CLEANUP_INTERVAL_MS) return
  lastUsageCleanupAt = now

  const keepFrom = keepFromDateKey(7)
  const rows = await ctx.database.get(DAILY_USAGE_TABLE, {})
  for (const row of rows) {
    if (row.date < keepFrom) {
      await ctx.database.remove(DAILY_USAGE_TABLE, { date: row.date })
    }
  }
}

export async function getTodayUsage(ctx: Context): Promise<number> {
  await cleanupOldUsageRows(ctx)
  const [row] = await ctx.database.get(DAILY_USAGE_TABLE, { date: todayKey() })
  const usage = normalizeUsageRow({ date: todayKey(), ...(row as any || {}) })
  return usage.apiGeneratedCount + usage.reservedCount
}

export async function addTodayUsage(ctx: Context, successDelta: number, webSearchDelta = 0) {
  if (!successDelta && !webSearchDelta) return
  await cleanupOldUsageRows(ctx)
  const date = todayKey()
  const [row] = await ctx.database.get(DAILY_USAGE_TABLE, { date })
  const next = normalizeUsageRow({ date, ...(row as any || {}) })
  next.successCount += successDelta
  next.messageSentCount += successDelta
  next.apiGeneratedCount += successDelta
  next.webSearchCount += webSearchDelta
  await ctx.database.upsert(DAILY_USAGE_TABLE, [next])
}

export async function checkDailyQuota(ctx: Context, dailyLimit: number, sequential: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const used = await getTodayUsage(ctx)
    const remaining = dailyLimit - used
    if (remaining <= 0) return { ok: false, message: '今日图片生成限额已用尽' }
    if (sequential === 'auto' && remaining === 1) {
      return { ok: false, message: '今日图片生成限额不支持组图生成，请关闭组图后尝试' }
    }
    return { ok: true }
  } catch (error) {
    logger.warn(error)
    return { ok: true }
  }
}

export class KoishiQuotaStore implements QuotaStore {
  constructor(private ctx: Context) {}

  async getToday(): Promise<DailyUsageSnapshot> {
    await cleanupOldUsageRows(this.ctx)
    const date = todayKey()
    const [row] = await this.ctx.database.get(DAILY_USAGE_TABLE, { date })
    return normalizeUsageRow({ date, ...(row as any || {}) })
  }

  async saveToday(row: DailyUsageSnapshot): Promise<void> {
    await cleanupOldUsageRows(this.ctx)
    await this.ctx.database.upsert(DAILY_USAGE_TABLE, [normalizeUsageRow(row)])
  }
}

// ── Image loading & validation ──

export async function loadImageSource(ctx: Context, src: string): Promise<{ buffer: Buffer; dataUri: string }> {
  const file = await ctx.http.file(src)
  const buffer = Buffer.from(file.data)
  const meta = detectImageMeta(buffer)
  const mime = meta?.mime || file.type || file.mime || 'application/octet-stream'
  return { buffer, dataUri: `data:${mime};base64,${buffer.toString('base64')}` }
}

export async function validateAndPrepareImages(
  ctx: Context, options: ImageGenOptions, imageSources: string[],
): Promise<{ ok: boolean; message?: string; images?: string[] }> {
  const rules = getImageRulesByModel(options.modelId, options.layerDecomposition)
  if (imageSources.length > rules.maxInputImages) {
    return { ok: false, message: `输入图片数量超限，当前模型最多支持 ${rules.maxInputImages} 张参考图` }
  }
  if (options.sequential === 'auto' && imageSources.length + options.sequentialMaxImages > 15) {
    return { ok: false, message: '输入的参考图数量与最终生成图片数量总和不能超过 15，请减少参考图或下调组图数量' }
  }
  const outputImages: string[] = []
  for (let i = 0; i < imageSources.length; i++) {
    const loaded = await loadImageSource(ctx, imageSources[i])
    const meta = detectImageMeta(loaded.buffer)
    const idx = i + 1
    if (!meta) return { ok: false, message: `第 ${idx} 张图片无法识别格式或尺寸信息` }
    if (!rules.allowedFormats.includes(meta.format)) {
      return { ok: false, message: `第 ${idx} 张图片格式不支持，当前模型仅支持 ${rules.allowedFormats.join('、')}` }
    }
    if (loaded.buffer.length > 30 * 1024 * 1024) return { ok: false, message: `第 ${idx} 张图片大小超过 30MB` }
    if (!options.layerDecomposition && (meta.width <= 14 || meta.height <= 14)) return { ok: false, message: `第 ${idx} 张图片宽高必须大于 14px` }
    const ratio = meta.width / meta.height
    if (ratio < rules.minRatio || ratio > rules.maxRatio) {
      return { ok: false, message: `第 ${idx} 张图片宽高比不符合要求，需在 [${rules.minRatio}, ${rules.maxRatio}] 范围内` }
    }
    const pixels = meta.width * meta.height
    if (options.layerDecomposition && pixels < 512 * 512) return { ok: false, message: `第 ${idx} 张图片总像素低于图层拆分要求的 262144` }
    if (pixels > 6000 * 6000) return { ok: false, message: `第 ${idx} 张图片总像素超过 36000000` }
    if (options.transparentBackground && !meta.hasAlpha) {
      return { ok: false, message: `第 ${idx} 张图片不包含透明通道；透明背景模式仅支持带 Alpha 通道的 PNG/WebP 图片` }
    }
    outputImages.push(loaded.dataUri)
  }
  return { ok: true, images: outputImages }
}

// ── API request ──

export interface ImageGenPayload {
  prompt: string
  images?: string[]
}

export interface ImageGenOptions {
  apiType: 'ark' | 'openai-compatible'
  apiKey: string
  endpoint: string
  modelId: string
  generationCount: number
  quality: string
  enableWebSearch: boolean
  size: ImageSize
  layerDecomposition: boolean
  transparentBackground: boolean
  sequential: string
  sequentialMaxImages: number
  optimizePromptMode: OptimizePromptMode
  watermark: boolean
  responseFormat: string
}

export async function requestImageGeneration(ctx: Context, options: ImageGenOptions, payload: ImageGenPayload): Promise<any> {
  const endpoint = resolveImageEndpoint(options, payload)
  const useMultipart = options.apiType === 'openai-compatible' && Boolean(payload.images?.length)
  const maskedKey = options.apiKey ? options.apiKey.slice(0, 4) + '***' + options.apiKey.slice(-4) : '(empty)'
  logger.debug(`请求参数: apiType=${options.apiType}, endpoint=${endpoint}, transport=${useMultipart ? 'multipart' : 'json'}, imageCount=${payload.images?.length || 0}, model=${options.modelId}, key=${maskedKey}`)
  const body = useMultipart
    ? buildOpenAICompatibleEditFormData(options, payload)
    : buildImageGenerationBody(options, payload)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
  }
  if (!useMultipart) headers['Content-Type'] = 'application/json'
  return ctx.http.post(endpoint, body, {
    headers,
  })
}

export function buildOptionsFromOpenAICompatible(config: OpenAICompatibleConfig): ImageGenOptions {
  return {
    apiType: 'openai-compatible',
    apiKey: config.apiKey || '',
    endpoint: config.baseURL || 'http://127.0.0.1:8000/v1',
    modelId: config.modelId || 'gpt-image-2',
    generationCount: Number(config.n || 1),
    quality: config.quality || 'auto',
    enableWebSearch: false,
    size: config.size || 'auto',
    layerDecomposition: false,
    transparentBackground: false,
    sequential: 'disabled',
    sequentialMaxImages: 1,
    optimizePromptMode: 'standard',
    watermark: false,
    responseFormat: config.responseFormat || 'b64_json',
  }
}

export function buildOptionsFromStandalone(config: Config): ImageGenOptions {
  if (config.openAICompatible?.enabled) {
    return buildOptionsFromOpenAICompatible(config.openAICompatible)
  }

  const standalone = config.standalone
  return {
    apiType: 'ark',
    apiKey: standalone.apiKey,
    endpoint: standalone.endpoint,
    modelId: standalone.modelId,
    generationCount: 1,
    quality: 'auto',
    enableWebSearch: standalone.enableWebSearch,
    size: standalone.size,
    layerDecomposition: standalone.layerDecomposition,
    transparentBackground: standalone.transparentBackground,
    sequential: standalone.sequentialImageGeneration,
    sequentialMaxImages: standalone.sequentialMaxImages,
    optimizePromptMode: standalone.optimizePromptMode,
    watermark: standalone.watermark,
    responseFormat: standalone.responseFormat,
  }
}

// ── Result handling ──

import { h } from 'koishi'
import type { Session } from 'koishi'

export async function sendGenerationResult(
  session: Session, responseFormat: string, withDetails: boolean, sequential: string, result: any,
  layerDecomposition = false,
): Promise<number> {
  const data = Array.isArray(result?.data) ? result.data : []
  let successCount = 0
  const shouldSendAsFigure = (sequential === 'auto' || layerDecomposition) && data.length > 1

  if (shouldSendAsFigure) {
    const messages: any[] = []
    for (const item of data) {
      if (responseFormat === 'url' && item?.url) {
        messages.push(h('message', {}, [h.image(item.url)]))
      } else if (responseFormat === 'b64_json' && item?.b64_json) {
        messages.push(h('message', {}, [h.image(asDataUri(item.b64_json))]))
      }
    }
    if (messages.length > 1) {
      successCount = messages.length
      await session.send(h('figure', {}, messages))
    }
  }

  if (!successCount) {
    for (const item of data) {
      if (responseFormat === 'url' && item?.url) {
        successCount += 1
        await session.send(item.url)
      } else if (responseFormat === 'b64_json' && item?.b64_json) {
        successCount += 1
        await session.send(h.image(asDataUri(item.b64_json)))
      }
    }
  }

  if (!successCount) {
    if (result?.error?.message || result?.error?.code) {
      const zh = translateErrorCode(result?.error?.code)
      await session.send(`生成失败：${result.error.code || '-'}${zh ? `（${zh}）` : ''}\n${result.error.message || ''}`.trim())
    } else {
      const dataErrors = data.map((item: any) => item?.error).filter(Boolean)
      if (dataErrors.length) {
        const first = dataErrors[0]
        const zh = translateErrorCode(first.code)
        await session.send(`生成失败：${first.code || '-'}${zh ? `（${zh}）` : ''}\n${first.message || ''}`.trim())
      } else {
        await session.send('生成失败：未返回可用图片。')
      }
    }
  }

  if (withDetails) {
    await session.send(buildDetailMessage(result))
  }

  return successCount
}
