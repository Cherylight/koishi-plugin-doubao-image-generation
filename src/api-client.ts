import { Context } from 'koishi'
import './types'
import {
  logger, normalizeApiError, detectImageMeta, parseDataUri, getImageRulesByModel,
  asDataUri, translateErrorCode, buildDetailMessage, DAILY_USAGE_TABLE, todayKey, keepFromDateKey
} from './utils'
import type { StandaloneConfig, ImageSize, OptimizePromptMode } from './config'

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
  return (row as any)?.successCount || 0
}

export async function addTodayUsage(ctx: Context, count: number) {
  if (!count) return
  await cleanupOldUsageRows(ctx)
  const date = todayKey()
  const [row] = await ctx.database.get(DAILY_USAGE_TABLE, { date })
  const successCount = ((row as any)?.successCount || 0) + count
  await ctx.database.upsert(DAILY_USAGE_TABLE, [{ date, successCount }])
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

// ── Image loading & validation ──

export async function loadImageSource(ctx: Context, src: string): Promise<{ buffer: Buffer; dataUri: string }> {
  const parsed = parseDataUri(src)
  if (parsed) {
    return { buffer: Buffer.from(parsed.base64, 'base64'), dataUri: src }
  }
  const data = await ctx.http.get(src, { responseType: 'arraybuffer' })
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  const meta = detectImageMeta(buffer)
  const mime = meta?.mime || 'image/png'
  return { buffer, dataUri: `data:${mime};base64,${buffer.toString('base64')}` }
}

export async function validateAndPrepareImages(
  ctx: Context, sequential: string, sequentialMax: number, imageSources: string[],
): Promise<{ ok: boolean; message?: string; images?: string[] }> {
  const rules = getImageRulesByModel()
  if (imageSources.length > rules.maxInputImages) {
    return { ok: false, message: `输入图片数量超限，当前模型最多支持 ${rules.maxInputImages} 张参考图` }
  }
  if (sequential === 'auto' && imageSources.length + sequentialMax > 15) {
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
    if (loaded.buffer.length > 10 * 1024 * 1024) return { ok: false, message: `第 ${idx} 张图片大小超过 10MB` }
    if (meta.width <= 14 || meta.height <= 14) return { ok: false, message: `第 ${idx} 张图片宽高必须大于 14px` }
    const ratio = meta.width / meta.height
    if (ratio < rules.minRatio || ratio > rules.maxRatio) {
      return { ok: false, message: `第 ${idx} 张图片宽高比不符合要求，需在 [${rules.minRatio}, ${rules.maxRatio}] 范围内` }
    }
    if (meta.width * meta.height > 6000 * 6000) return { ok: false, message: `第 ${idx} 张图片总像素超过 36000000` }
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
  apiKey: string
  endpoint: string
  modelId: string
  size: ImageSize
  sequential: string
  sequentialMaxImages: number
  optimizePromptMode: OptimizePromptMode
  watermark: boolean
  responseFormat: string
}

export async function requestImageGeneration(ctx: Context, options: ImageGenOptions, payload: ImageGenPayload): Promise<any> {
  const maskedKey = options.apiKey ? options.apiKey.slice(0, 4) + '***' + options.apiKey.slice(-4) : '(empty)'
  logger.debug(`请求参数: endpoint=${options.endpoint}, model=${options.modelId}, key=${maskedKey}`)
  const body: Record<string, any> = {
    model: options.modelId,
    prompt: payload.prompt,
    size: options.size,
    sequential_image_generation: options.sequential,
    optimize_prompt_options: { mode: options.optimizePromptMode },
    watermark: options.watermark,
    response_format: options.responseFormat,
    stream: false,
  }
  if (options.sequential === 'auto') {
    body.sequential_image_generation_options = { max_images: options.sequentialMaxImages }
  }
  if (payload.images?.length) {
    body.image = payload.images.length === 1 ? payload.images[0] : payload.images
  }
  return ctx.http.post(options.endpoint, body, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
  })
}

export function buildOptionsFromStandalone(config: StandaloneConfig): ImageGenOptions {
  return {
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    modelId: config.modelId,
    size: config.size,
    sequential: config.sequentialImageGeneration,
    sequentialMaxImages: config.sequentialMaxImages,
    optimizePromptMode: config.optimizePromptMode,
    watermark: config.watermark,
    responseFormat: config.responseFormat,
  }
}

// ── Result handling ──

import { h } from 'koishi'
import type { Session } from 'koishi'

export async function sendGenerationResult(
  session: Session, responseFormat: string, withDetails: boolean, sequential: string, result: any,
): Promise<number> {
  const data = Array.isArray(result?.data) ? result.data : []
  let successCount = 0
  const shouldSendAsFigure = sequential === 'auto' && data.length > 1

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
