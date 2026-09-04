import { Context, Session, h } from 'koishi'
import './types'
import type { Config } from './config'
import { resolveDailyLimit } from './config'
import { ContextManager, ContextEntry } from './context-manager'
import {
  extractImages, extractText, normalizeApiError, logger, IMAGE_SWITCH_TABLE, extractWebSearchUsage,
} from './utils'
import {
  validateAndPrepareImages, requestImageGeneration,
  sendGenerationResult, buildOptionsFromStandalone,
} from './api-client'
import {
  buildDedupeKey,
  GenerationController,
  resolveSessionLockKey,
} from './generation-controller'
import { validateRuntimeRequest } from './request-options'

export function registerStandaloneCommands(
  ctx: Context,
  config: Config,
  contextManager: ContextManager,
  generationController: GenerationController,
) {
  const sc = config.standalone

  const DEFAULT_SWITCH = { textToImage: true, imageToImage: true }

  function getChannelKey(session: Session) {
    return `${session.platform}:${session.channelId}`
  }

  async function getChannelSwitch(session: Session) {
    const channelKey = getChannelKey(session)
    const [row] = await ctx.database.get(IMAGE_SWITCH_TABLE, { channelKey })
    if (!row) return { ...DEFAULT_SWITCH }
    return {
      textToImage: row.textToImage !== false,
      imageToImage: row.imageToImage !== false,
    }
  }

  async function setChannelSwitch(session: Session, value: { textToImage: boolean; imageToImage: boolean }) {
    const channelKey = getChannelKey(session)
    await ctx.database.upsert(IMAGE_SWITCH_TABLE, [{
      channelKey,
      textToImage: value.textToImage,
      imageToImage: value.imageToImage,
      updatedAt: Date.now(),
    }])
  }

  async function checkModeEnabled(session: Session, useImageInput: boolean) {
    const current = await getChannelSwitch(session)
    const enabled = useImageInput ? current.imageToImage : current.textToImage
    if (enabled) return null
    const mode = useImageInput ? '图生图' : '文生图'
    return session.text('commands.gen.messages.gen-mode-disabled', { mode })
  }

  async function runGeneration(session: Session, prompt: string, images?: string[]) {
    const options = buildOptionsFromStandalone(config)
    validateRuntimeRequest(options, { prompt, images })
    const quotaUnits = options.apiType === 'openai-compatible'
      ? options.generationCount
      : options.layerDecomposition
        ? 17
        : options.sequential === 'auto' ? options.sequentialMaxImages : 1
    const withResultDetails = options.apiType === 'openai-compatible'
      ? Boolean(config.openAICompatible.withResultDetails)
      : sc.withResultDetails
    const resultGrouping = options.apiType === 'openai-compatible' && options.generationCount > 1
      ? 'auto'
      : options.sequential
    const lockKey = resolveSessionLockKey(session)
    const dedupeKey = buildDedupeKey(
      lockKey,
      prompt,
      `standalone:${options.apiType}:${options.modelId}:${options.size}:${options.generationCount}:${options.responseFormat}:${options.layerDecomposition}:${options.transparentBackground}:${options.sequential}:${(images || []).join(',')}`,
    )

    const output = await generationController.run({
      prompt,
      images,
      responseFormat: options.responseFormat,
      quotaUnits,
      dailyLimit: resolveDailyLimit(config),
      lockKey,
      dedupeKey,
      generate: async () => {
        await session.send(session.text('commands.gen.messages.gen-working'))
        return requestImageGeneration(ctx, options, { prompt, images })
      },
      sendResult: (result) => sendGenerationResult(
        session,
        options.responseFormat,
        withResultDetails,
        resultGrouping,
        result,
        options.layerDecomposition,
      ),
      webSearchUsage: extractWebSearchUsage,
    })

    if (output.status === 'ok' || output.status === 'no_image') return
    return output.message
  }

  async function prepareAndRunWithImages(session: Session, finalPrompt: string, images: string[]) {
    const options = buildOptionsFromStandalone(config)
    const requestPrompt = options.layerDecomposition ? finalPrompt : finalPrompt || 'regenerate'
    validateRuntimeRequest(options, { prompt: requestPrompt, images })
    const checked = await validateAndPrepareImages(ctx, options, images)
    if (!checked.ok) return `图生图失败：${checked.message}`
    return runGeneration(session, requestPrompt, checked.images)
  }

  // ── gen: 文生图 / 图生图主入口 ──
  ctx.command('gen <prompt:text>', '图片生成')
    .action(async ({ session }, prompt) => {
      if (!session) return
      const rawContent = session.content || ''
      const images = extractImages(rawContent)
      const finalPrompt = (prompt || '').trim()

      if (!finalPrompt && !images.length) {
        return session.text('.gen-no-input')
      }

      const modeError = await checkModeEnabled(session, images.length > 0)
      if (modeError) return modeError

      try {
        if (images.length) {
          // 图生图
          return prepareAndRunWithImages(session, finalPrompt, images)
        } else {
          // 文生图
          return runGeneration(session, finalPrompt)
        }
      } catch (error: any) {
        logger.warn('API 调用错误:', error)
        if (error?.response) {
          logger.warn('HTTP 响应:', JSON.stringify(error.response.data ?? error.response.statusText ?? error.response.status))
        }
        const info = normalizeApiError(error)
        return `调用失败：${info.code || '-'}${info.zh ? `（${info.zh}）` : ''}\n${info.message || ''}`.trim()
      }
    })

  ctx.command('gen-switch', '图片生成功能开关', { authority: 3 })
    .option('t2i', '--t2i <state:string>', { fallback: undefined })
    .option('i2i', '--i2i <state:string>', { fallback: undefined })
    .action(async ({ session, options }) => {
      if (!session) return
      const current = await getChannelSwitch(session)

      if (!options?.t2i && !options?.i2i) {
        return session.text('.gen-switch-status', {
          t2i: current.textToImage ? 'on' : 'off',
          i2i: current.imageToImage ? 'on' : 'off',
        })
      }

      if (options.t2i) {
        if (options.t2i !== 'on' && options.t2i !== 'off') return session.text('.gen-switch-invalid')
        current.textToImage = options.t2i === 'on'
      }
      if (options.i2i) {
        if (options.i2i !== 'on' && options.i2i !== 'off') return session.text('.gen-switch-invalid')
        current.imageToImage = options.i2i === 'on'
      }

      await setChannelSwitch(session, current)
      return session.text('.gen-switch-updated', {
        t2i: current.textToImage ? 'on' : 'off',
        i2i: current.imageToImage ? 'on' : 'off',
      })
    })

  // ── gen-append: 追加上下文（引用消息或直接输入） ──
  ctx.command('gen-append', '追加图片生成上下文')
    .action(async ({ session }) => {
      if (!session) return

      const rawContent = session.content || ''
      const quoteContent = session.quote?.content || ''

      // 确定来源内容：引用消息优先，否则使用命令后的内容
      let sourceContent = quoteContent || ''

      // 直接从整条消息体中提取命令后文本：优先解析文本节点，避免被 @mention 等元素干扰
      const rawText = extractText(rawContent)
      const textMatch = rawText.match(/(?:^|\s)gen-append(?:\s+|$)([\s\S]*)/i)
      const rawMatch = rawContent.match(/gen-append([\s\S]*)/i)
      const afterCmd = (textMatch?.[1] || rawMatch?.[1] || '').trim()

      if (!sourceContent && !afterCmd) {
        return session.text('.gen-append-empty')
      }

      // 将 sourceContent 和 afterCmd 合并
      const combinedContent = sourceContent ? sourceContent + (afterCmd ? '\n' + afterCmd : '') : afterCmd

      const images = extractImages(combinedContent)
      const text = extractText(combinedContent)

      const modeError = await checkModeEnabled(session, images.length > 0)
      if (modeError) return modeError

      const entries: ContextEntry[] = []
      if (text) entries.push({ type: 'text', content: text })
      for (const img of images) entries.push({ type: 'image', content: img })

      if (!entries.length) {
        return session.text('.gen-append-empty')
      }

      const expireNotify = () => {
        session.send(session.text('commands.gen-append.messages.gen-context-expired')).catch(() => {})
      }

      const userCtx = contextManager.append(
        session.platform, session.channelId!, session.userId!,
        entries, expireNotify,
      )

      const textCount = userCtx.entries.filter(e => e.type === 'text').length
      const imageCount = userCtx.entries.filter(e => e.type === 'image').length

      return session.text('.gen-append-success', { textCount, imageCount })
    })

  // ── gen-ctx: 查看/清空上下文 或 以当前上下文发送请求 ──
  ctx.command('gen-ctx', '管理图片生成上下文')
    .option('clear', '-c')
    .option('send', '-s')
    .action(async ({ session, options }) => {
      if (!session) return

      if (options?.clear) {
        const cleared = contextManager.clear(session.platform, session.channelId!, session.userId!)
        if (!cleared) return session.text('.gen-ctx-empty')
        return session.text('.gen-ctx-cleared')
      }

      if (options?.send) {
        const userCtx = contextManager.getAndClear(session.platform, session.channelId!, session.userId!)
        if (!userCtx || !userCtx.entries.length) {
          return session.text('.gen-ctx-empty')
        }

        const texts = userCtx.entries.filter(e => e.type === 'text').map(e => e.content)
        const images = userCtx.entries.filter(e => e.type === 'image').map(e => e.content)
        const finalPrompt = texts.join(' ').trim()

        if (!finalPrompt && !images.length) {
          return session.text('.gen-ctx-empty')
        }

        const modeError = await checkModeEnabled(session, images.length > 0)
        if (modeError) return modeError

        try {
          if (images.length) {
            return prepareAndRunWithImages(session, finalPrompt, images)
          } else if (finalPrompt) {
            return runGeneration(session, finalPrompt)
          } else {
            return session.text('.gen-ctx-no-prompt')
          }
        } catch (error) {
          logger.warn(error)
          const info = normalizeApiError(error)
          return `调用失败：${info.code || '-'}${info.zh ? `（${info.zh}）` : ''}\n${info.message || ''}`.trim()
        }
        return
      }

      // 默认：查看当前上下文
      const userCtx = contextManager.get(session.platform, session.channelId!, session.userId!)
      if (!userCtx || !userCtx.entries.length) {
        return session.text('.gen-ctx-empty')
      }

      const textCount = userCtx.entries.filter(e => e.type === 'text').length
      const imageCount = userCtx.entries.filter(e => e.type === 'image').length
      const remaining = Math.max(0, Math.ceil(60 - (Date.now() - userCtx.updatedAt) / 1000))

      return session.text('.gen-ctx-info', { textCount, imageCount, remaining })
    })
}
