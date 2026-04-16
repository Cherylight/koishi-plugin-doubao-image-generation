import { Context, Session, h } from 'koishi'
import './types'
import type { Config } from './config'
import { ContextManager, ContextEntry } from './context-manager'
import {
  extractImages, extractText, normalizeApiError, logger,
} from './utils'
import {
  checkDailyQuota, validateAndPrepareImages, requestImageGeneration,
  sendGenerationResult, addTodayUsage, buildOptionsFromStandalone,
} from './api-client'

export function registerStandaloneCommands(ctx: Context, config: Config, contextManager: ContextManager) {
  const sc = config.standalone

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

      try {
        const quota = await checkDailyQuota(ctx, sc.dailySuccessLimit, sc.sequentialImageGeneration)
        if (!quota.ok) return quota.message

        const options = buildOptionsFromStandalone(sc)

        if (images.length) {
          // 图生图
          const checked = await validateAndPrepareImages(ctx, sc.sequentialImageGeneration, sc.sequentialMaxImages, images)
          if (!checked.ok) return `图生图失败：${checked.message}`
          await session.send(session.text('.gen-working'))
          const result = await requestImageGeneration(ctx, options, {
            prompt: finalPrompt || 'regenerate',
            images: checked.images,
          })
          const count = await sendGenerationResult(session, sc.responseFormat, sc.withResultDetails, sc.sequentialImageGeneration, result)
          await addTodayUsage(ctx, count)
        } else {
          // 文生图
          await session.send(session.text('.gen-working'))
          const result = await requestImageGeneration(ctx, options, { prompt: finalPrompt })
          const count = await sendGenerationResult(session, sc.responseFormat, sc.withResultDetails, sc.sequentialImageGeneration, result)
          await addTodayUsage(ctx, count)
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

  // ── gen-switch: 全局开关管理 ──
  const switches = new Map<string, { textToImage: boolean; imageToImage: boolean }>()
  const switchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const SWITCH_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000
  const MAX_SWITCHES = 5000

  function clearSwitchTimer(channelKey: string) {
    const timer = switchTimers.get(channelKey)
    if (!timer) return
    clearTimeout(timer)
    switchTimers.delete(channelKey)
  }

  function resetSwitchTimer(channelKey: string) {
    clearSwitchTimer(channelKey)
    const timer = setTimeout(() => {
      switches.delete(channelKey)
      switchTimers.delete(channelKey)
    }, SWITCH_EXPIRE_MS)
    switchTimers.set(channelKey, timer)
  }

  function setSwitch(channelKey: string, value: { textToImage: boolean; imageToImage: boolean }) {
    if (!switches.has(channelKey) && switches.size >= MAX_SWITCHES) {
      const oldestKey = switches.keys().next().value as string | undefined
      if (oldestKey) {
        switches.delete(oldestKey)
        clearSwitchTimer(oldestKey)
      }
    }
    switches.set(channelKey, value)
    resetSwitchTimer(channelKey)
  }

  function getSwitch(channelKey: string) {
    return switches.get(channelKey) ?? { textToImage: false, imageToImage: false }
  }

  ctx.on('dispose', () => {
    for (const timer of switchTimers.values()) clearTimeout(timer)
    switchTimers.clear()
    switches.clear()
  })

  ctx.command('gen-switch', '图片生成功能开关', { authority: 3 })
    .option('t2i', '--t2i <state:string>', { fallback: undefined })
    .option('i2i', '--i2i <state:string>', { fallback: undefined })
    .action(async ({ session, options }) => {
      if (!session) return
      const key = `${session.platform}:${session.channelId}`
      const current = getSwitch(key)

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

      setSwitch(key, current)
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

      // 使用 Koishi 命令解析结果取命令后文本，正确处理命令前有 @mention 等前缀的情况
      const afterCmd = (session.argv?.rest || '').trim()

      if (!sourceContent && !afterCmd) {
        return session.text('.gen-append-empty')
      }

      // 将 sourceContent 和 afterCmd 合并
      const combinedContent = sourceContent ? sourceContent + (afterCmd ? '\n' + afterCmd : '') : afterCmd

      const images = extractImages(combinedContent)
      const text = extractText(combinedContent)

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

        try {
          const quota = await checkDailyQuota(ctx, sc.dailySuccessLimit, sc.sequentialImageGeneration)
          if (!quota.ok) return quota.message

          const genOptions = buildOptionsFromStandalone(sc)

          if (images.length) {
            const checked = await validateAndPrepareImages(ctx, sc.sequentialImageGeneration, sc.sequentialMaxImages, images)
            if (!checked.ok) return `图生图失败：${checked.message}`
            await session.send(session.text('commands.gen.messages.gen-working'))
            const result = await requestImageGeneration(ctx, genOptions, {
              prompt: finalPrompt || 'regenerate',
              images: checked.images,
            })
            const count = await sendGenerationResult(session, sc.responseFormat, sc.withResultDetails, sc.sequentialImageGeneration, result)
            await addTodayUsage(ctx, count)
          } else if (finalPrompt) {
            await session.send(session.text('commands.gen.messages.gen-working'))
            const result = await requestImageGeneration(ctx, genOptions, { prompt: finalPrompt })
            const count = await sendGenerationResult(session, sc.responseFormat, sc.withResultDetails, sc.sequentialImageGeneration, result)
            await addTodayUsage(ctx, count)
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
