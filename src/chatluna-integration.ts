import { Context, h } from 'koishi'
import './types'
import type { Config, ChatlunaConfig } from './config'
import { resolveDailyLimit } from './config'
import { logger, asDataUri, normalizeApiError, translateErrorCode, extractWebSearchUsage } from './utils'
import {
  buildChatlunaToolDescription,
  classifyImageGenerationError,
} from './chatluna-tool-result'
import {
  requestImageGeneration, validateAndPrepareImages, buildOptionsFromOpenAICompatible,
  type ImageGenOptions,
} from './api-client'
import {
  buildDedupeKey,
  GenerationController,
  resolveSessionLockKey,
} from './generation-controller'
import * as fs from 'fs'
import * as path from 'path'

// Type stubs — full types come from devDependencies at build time
type StructuredTool = import('@langchain/core/tools').StructuredTool
type ChatLunaPlugin = any
type ChatLunaTool = any

interface DoubaoAdapterConfig {
  apiKeys: [string, string, boolean][]
}

function buildFailureResult(
  category: string,
  message: string,
  retryable: boolean,
  suggestedAction: string,
  details: {
    code?: string
    type?: string
    localizedMessage?: string
    httpStatus?: number
    statusText?: string
    requestId?: string
    generatedCount?: number
    sentCount?: number
  } = {},
) {
  const {
    generatedCount = 0,
    sentCount = 0,
    ...errorDetails
  } = details
  return {
    success: false,
    status: 'failed',
    message,
    delivery: {
      imagesGenerated: generatedCount,
      imagesSent: sentCount,
      failureNoticeSent: false,
    },
    error: {
      category,
      ...errorDetails,
      retryable,
      suggestedAction,
    },
  }
}

function resolveAdapterCredentials(ctx: Context): { apiKey: string; endpointBase: string } | null {
  try {
    // Access the chatluna-doubao-adapter config from the Koishi config tree
    const configService = ctx.root.config as any
    // Walk the plugin tree to find active doubao-adapter config
    // The adapter stores apiKeys as array of [apiKey, endpoint, enabled]
    const pluginConfigs = configService?.plugins || configService
    if (!pluginConfigs) return null

    // Try to find the adapter through the context scope
    // The adapter config is typically nested in a group
    let adapterConfig: DoubaoAdapterConfig | null = null

    // Search through the flat plugin config for any doubao-adapter entry
    const findAdapterConfig = (obj: any): DoubaoAdapterConfig | null => {
      if (!obj || typeof obj !== 'object') return null
      for (const key of Object.keys(obj)) {
        if (key.startsWith('chatluna-doubao-adapter')) {
          const cfg = obj[key]
          if (cfg?.apiKeys?.length) return cfg
        }
        // Recurse into groups
        if (key.startsWith('group:') || key.startsWith('group')) {
          const found = findAdapterConfig(obj[key])
          if (found) return found
        }
      }
      return null
    }

    adapterConfig = findAdapterConfig(pluginConfigs)
    if (!adapterConfig?.apiKeys?.length) return null

    // Find the first enabled apiKey entry
    const enabledEntry = adapterConfig.apiKeys.find(entry => entry[2] === true)
    if (!enabledEntry) return null

    return { apiKey: enabledEntry[0], endpointBase: enabledEntry[1] }
  } catch (e) {
    logger.debug('Failed to resolve doubao adapter credentials:', e)
    return null
  }
}

function buildChatlunaGenOptions(
  config: Config,
  credentials: { apiKey: string; endpointBase: string } | null,
): ImageGenOptions {
  if (config.openAICompatible?.enabled) {
    return buildOptionsFromOpenAICompatible(config.openAICompatible)
  }
  if (!credentials) throw new Error('未找到可用的 chatluna-doubao-adapter 配置')

  const chatlunaConfig = config.chatluna
  let endpoint = credentials.endpointBase
  if (!endpoint.endsWith('/')) endpoint += '/'
  if (!endpoint.endsWith('images/generations')) {
    endpoint += 'images/generations'
  }

  return {
    apiType: 'ark',
    apiKey: credentials.apiKey,
    endpoint,
    modelId: chatlunaConfig.modelId,
    generationCount: 1,
    quality: 'auto',
    enableWebSearch: chatlunaConfig.enableWebSearch,
    size: chatlunaConfig.size,
    layerDecomposition: false,
    transparentBackground: false,
    sequential: 'disabled',
    sequentialMaxImages: 1,
    optimizePromptMode: chatlunaConfig.optimizePromptMode,
    watermark: chatlunaConfig.watermark,
    responseFormat: 'b64_json',
  }
}

/**
 * 初始化预设图片目录：将插件包内 presets/ 释放到 data/<presetsDir>/
 */
export function initPresetsDir(ctx: Context, config: Config) {
  const cc = config.chatluna
  const targetDir = path.resolve(ctx.baseDir, 'data', cc.presetsDir)

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
      logger.info(`已创建人设参考图目录: ${targetDir}`)
    }

    // __dirname 在 CJS bundle 中指向 lib/，presets/ 在包的根目录
    const srcDir = path.resolve(__dirname, '..', 'presets')
    if (fs.existsSync(srcDir)) {
      for (const file of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, file)
        const dest = path.join(targetDir, file)
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest)
          logger.info(`已释放预设文件: ${file} -> ${targetDir}`)
        }
      }
    }
  } catch (error) {
    logger.warn('初始化人设参考图目录失败，将跳过预设文件释放:', error)
  }
}

/**
 * 根据当前 character 预设名，查找对应的人设参考图路径。
 * 约定：文件名为 "<presetName>.png"
 */
function resolvePresetImage(ctx: Context, presetsDir: string, presetName: string): string | null {
  if (!presetName) return null
  const filePath = path.resolve(ctx.baseDir, 'data', presetsDir, `${presetName}.png`)
  if (fs.existsSync(filePath)) return filePath
  return null
}

export function registerChatlunaIntegration(ctx: Context, config: Config, generationController: GenerationController) {
  const cc = config.chatluna
  if (!cc.enabled) return

  // Check if chatluna service is available
  if (!ctx.chatluna) {
    logger.warn('ChatLuna 模式已启用，但 chatluna 服务未加载，跳过工具注册')
    return
  }

  const credentials = config.openAICompatible?.enabled ? null : resolveAdapterCredentials(ctx)
  if (!config.openAICompatible?.enabled && !credentials) {
    logger.warn('ChatLuna 模式已启用，但未找到可用的 chatluna-doubao-adapter 配置，跳过工具注册')
    return
  }

  const generationOptions = buildChatlunaGenOptions(config, credentials)
  const toolDescription = buildChatlunaToolDescription(cc.toolDescription)

  logger.info(`ChatLuna 模式已激活，正在使用 ${generationOptions.apiType === 'openai-compatible' ? 'OpenAI 兼容接口' : 'ARK 接口'} 注册 photo_generation 工具...`)

  // 初始化预设图片目录
  initPresetsDir(ctx, config)

  // Dynamically import zod and langchain at tool creation time
  const { z } = require('zod')
  const { StructuredTool: StructuredToolClass } = require('@langchain/core/tools')

  const toolSchema = z.object({
    prompt: z.string().describe(
      'A detailed text description of the image to generate. Be specific about content, style, colors, composition, mood, lighting, and any other visual details.'
    ),
    use_preset_image: z.boolean().optional().default(false).describe(
      'Whether to attach the current character preset reference image for image-to-image generation. When true, the plugin will look for a PNG file named after the current character preset in the presets directory and use it as a reference image for style-consistent generation. Only set to true when you want the generated image to maintain visual consistency with the character design.'
    ),
  })

  class PhotoGenerationTool extends StructuredToolClass {
    name = 'photo_generation'
    description = toolDescription
    schema = toolSchema

    private genCtx: Context
    private genConfig: ChatlunaConfig
    private genOptions: ImageGenOptions

    constructor(genCtx: Context, genConfig: ChatlunaConfig, genOptions: ImageGenOptions) {
      super({})
      this.genCtx = genCtx
      this.genConfig = genConfig
      this.genOptions = genOptions
    }

    async _call(
      input: { prompt: string; use_preset_image?: boolean },
      _runManager?: any,
      parentConfig?: any,
    ): Promise<string> {
      const configurable = parentConfig?.configurable || {}
      const session = configurable.session
      const conversationId: string = configurable.conversationId || ''
      const presetName: string = parentConfig?.configurable?.preset || ''
      const lockKey = resolveSessionLockKey(session, conversationId)
      if (lockKey === 'global') {
        logger.warn('photo_generation 缺少 ChatLuna session/conversationId，上下文隔离退化为全局锁')
      }
      const dedupeKey = buildDedupeKey(
        lockKey,
        input.prompt,
        `chatluna:${presetName}:${input.use_preset_image ? 'preset' : 'text'}`,
      )

      try {
        const options = this.genOptions
        let preparedImages: string[] | undefined

        // 如果请求附加人设图，解析预设图片
        if (input.use_preset_image && presetName) {
          const presetImagePath = resolvePresetImage(this.genCtx, this.genConfig.presetsDir, presetName)
          if (presetImagePath) {
            try {
              const buffer = fs.readFileSync(presetImagePath)
              const dataUri = `data:image/png;base64,${buffer.toString('base64')}`
              const validated = await validateAndPrepareImages(this.genCtx, options, [dataUri])
              if (validated.ok && validated.images?.length) {
                preparedImages = validated.images
                logger.debug(`已附加人设参考图: ${presetName}.png`)
              } else {
                logger.warn(`人设参考图验证失败 (${presetName}.png): ${validated.message}`)
              }
            } catch (e) {
              logger.warn(`读取人设参考图失败 (${presetName}.png):`, e)
            }
          } else {
            logger.warn(`未找到人设参考图: ${presetName}.png，将仅进行文生图`)
          }
        }

        const output = await generationController.run({
          prompt: input.prompt,
          images: preparedImages,
          responseFormat: options.responseFormat,
          quotaUnits: options.apiType === 'openai-compatible' ? options.generationCount : 1,
          dailyLimit: resolveDailyLimit(config),
          lockKey,
          dedupeKey,
          generate: () => requestImageGeneration(this.genCtx, options, {
            prompt: input.prompt,
            images: preparedImages,
          }),
          sendResult: async (result) => {
            const data = Array.isArray(result?.data) ? result.data : []
            let sentCount = 0

            // 直接发送图片给用户（不返回图片数据给 LLM）
            if (session) {
              for (const item of data) {
                if (item?.b64_json) {
                  await session.send(h.image(asDataUri(item.b64_json)))
                  sentCount += 1
                } else if (item?.url) {
                  await session.send(h.image(item.url))
                  sentCount += 1
                }
              }
            }

            if (sentCount > 0) return sentCount

            return sentCount
          },
          webSearchUsage: extractWebSearchUsage,
        })

        if (output.status === 'ok') {
          if (output.sentCount > 0) {
            return JSON.stringify({
              success: true,
              status: 'success',
              message: output.message,
              delivery: { imagesGenerated: output.generatedCount, imagesSent: output.sentCount },
            })
          }
          return JSON.stringify(buildFailureResult(
            'delivery_failed',
            '图片已生成，但未能发送给用户。',
            false,
            'Do not repeat the same request in this turn. Continue naturally and briefly acknowledge that the image could not be delivered if needed.',
            { generatedCount: output.generatedCount, sentCount: output.sentCount },
          ))
        }
        if (output.status === 'no_image') {
          const err = output.result?.error || (output.result?.data || []).find((d: any) => d?.error)?.error
          if (err) {
            const classification = classifyImageGenerationError({
              code: err.code,
              type: err.type,
              message: err.message,
            })
            return JSON.stringify(buildFailureResult(
              classification.category,
              err.message || output.message,
              classification.retryable,
              classification.suggestedAction,
              {
                code: err.code,
                type: err.type,
                localizedMessage: err.code ? translateErrorCode(err.code) : undefined,
              },
            ))
          }
          return JSON.stringify(buildFailureResult(
            'empty_response',
            output.message,
            true,
            'Retry once. If the provider again returns no image, stop retrying and continue naturally without the image.',
          ))
        }
        if (output.status === 'quota_exceeded') {
          return JSON.stringify(buildFailureResult(
            'plugin_quota_exhausted',
            output.message,
            false,
            'Do not retry in this turn. Continue naturally without the image and suggest trying again after the plugin quota resets if needed.',
          ))
        }
        if (output.status === 'busy') {
          return JSON.stringify(buildFailureResult(
            'request_in_progress',
            output.message,
            true,
            'Do not claim that this request will finish asynchronously. Retry later only if the user still needs the image.',
          ))
        }
        if (output.status === 'duplicate') {
          return JSON.stringify(buildFailureResult(
            'duplicate_request',
            output.message,
            false,
            'Do not repeat the same request in this turn. Continue from the earlier result.',
          ))
        }
        return JSON.stringify(buildFailureResult(
          'delivery_failed',
          output.message,
          false,
          'Do not repeat the same request in this turn. Continue naturally and briefly acknowledge that the image could not be delivered if needed.',
          { generatedCount: output.generatedCount, sentCount: output.sentCount },
        ))
      } catch (error: any) {
        const info = normalizeApiError(error)
        if (info.category === 'unknown') {
          logger.warn('photo_generation internal or unclassified error:', error)
        } else {
          logger.warn(
            'photo_generation failed: category=%s code=%s httpStatus=%s requestId=%s message=%s',
            info.category,
            info.code || '-',
            info.httpStatus || '-',
            info.requestId || '-',
            info.message || '-',
          )
          logger.debug('photo_generation upstream error details:', error)
        }
        return JSON.stringify(buildFailureResult(
          info.category,
          info.message || info.zh || '图片生成调用失败',
          info.retryable,
          info.suggestedAction,
          {
            code: info.code,
            type: info.type,
            localizedMessage: info.zh,
            httpStatus: info.httpStatus,
            statusText: info.statusText,
            requestId: info.requestId,
          },
        ))
      }
    }
  }

  // Use ChatLunaPlugin to register the tool
  try {
    const { ChatLunaPlugin } = require('koishi-plugin-chatluna/services/chat')
    const plugin = new ChatLunaPlugin(ctx, config, 'doubao-image-generation', false)

    plugin.registerTool('photo_generation', {
      description: toolDescription,
      selector: () => true,
      createTool: () => new PhotoGenerationTool(ctx, cc, generationOptions),
      meta: {
        source: 'extension',
        group: 'doubao-image-generation',
        tags: ['image', 'generation', 'doubao'],
        defaultAvailability: {
          enabled: true,
          main: true,
          chatluna: true,
          characterScope: 'all',
        },
      },
    })

    ctx.on('dispose', () => {
      try {
        plugin.dispose?.()
      } catch (error) {
        logger.debug('释放 ChatLuna 工具资源时出现异常:', error)
      }
    })

    logger.info('photo_generation 工具注册成功')
  } catch (e) {
    logger.warn('ChatLuna 工具注册失败:', e)
  }
}
