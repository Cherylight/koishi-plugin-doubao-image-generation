import { Schema } from 'koishi'

export type ImageSize = string
export type SequentialMode = 'disabled' | 'auto'
export type OptimizePromptMode = 'standard' | 'fast'
export type ResponseFormat = 'b64_json' | 'url'
export type ImageApiType = 'ark' | 'openai-compatible'

export interface StandaloneConfig {
  apiKey: string
  endpoint: string
  modelId: string
  enableWebSearch: boolean
  size: ImageSize
  layerDecomposition: boolean
  transparentBackground: boolean
  sequentialImageGeneration: SequentialMode
  sequentialMaxImages: number
  optimizePromptMode: OptimizePromptMode
  watermark: boolean
  responseFormat: ResponseFormat
  dailySuccessLimit: number
  withResultDetails: boolean
}

export interface ChatlunaConfig {
  enabled: boolean
  modelId: string
  enableWebSearch: boolean
  size: ImageSize
  optimizePromptMode: OptimizePromptMode
  watermark: boolean
  toolDescription: string
  presetsDir: string
}

export interface QuotaConfig {
  dailyImageLimit: number
}

export interface OpenAICompatibleConfig {
  enabled?: boolean
  baseURL?: string
  apiKey?: string
  modelId?: string
  size?: string
  n?: number
  quality?: string
  responseFormat?: ResponseFormat
  dailySuccessLimit?: number
  withResultDetails?: boolean
}

export interface Config {
  standalone: StandaloneConfig
  chatluna: ChatlunaConfig
  quota: QuotaConfig
  openAICompatible: OpenAICompatibleConfig
}

const StandaloneSchema: Schema<StandaloneConfig> = Schema.object({
  apiKey: Schema.string().role('secret')
    .default('')
    .description('火山方舟 API Key（可留空，仅使用 ChatLuna 模式时无需填写）'),
  endpoint: Schema.string()
    .default('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    .description('图片生成接口完整地址'),
  modelId: Schema.string()
    .default('doubao-seedream-4-5-251128')
    .description('模型 ID'),
  enableWebSearch: Schema.boolean()
    .default(false)
    .description('是否启用联网搜索（仅对 doubao-seedream-5-0 系列生效）'),
  size: Schema.string()
    .default('4K')
    .description('输出尺寸。支持分辨率档位或宽高像素值，格式与范围由模型决定；配置界面不校验，非法值会在运行时提示。\n\n- **Seedream 5.0 Pro 图片生成**：`1K`、`1.5K`、`2K`，或如 `2048x1024`（总像素 921600～4624220，宽高比 1/16～16）\n- **Seedream 5.0 Pro 图层拆分**：`auto`、`1K`、`1.5K`、`2K`\n- **Seedream 5.0 Lite**：`2K`、`3K`、`4K`，或如 `3750x1250`\n- **Seedream 4.5 / 4.0**：`2K`、`4K`（4.0 另支持 `1K`），或如 `3750x1250`'),
  layerDecomposition: Schema.boolean()
    .default(false)
    .description('图层拆分模式。仅 Seedream 5.0 Pro 支持；必须输入 1 张 PNG/JPEG，输出底图和多个透明 PNG 图层。与组图模式互斥'),
  transparentBackground: Schema.boolean()
    .default(false)
    .description('图片透明通道。仅 Seedream 5.0 Pro 图生图支持；必须输入 1 张带透明通道的图片，输出强制为 PNG'),
  sequentialImageGeneration: Schema.union([
    Schema.const('disabled').description('disabled'),
    Schema.const('auto').description('auto'),
  ] as const)
    .default('disabled')
    .description('组图功能开关。与图层拆分模式互斥；Seedream 5.0 Pro 不支持组图'),
  sequentialMaxImages: Schema.number().min(1).max(15).step(1)
    .default(15)
    .description('组图最大图片数（仅在组图=auto 时生效）'),
  optimizePromptMode: Schema.union([
    Schema.const('standard').description('standard'),
    Schema.const('fast').description('fast'),
  ] as const)
    .default('standard')
    .description('提示词优化模式'),
  watermark: Schema.boolean()
    .default(false)
    .description('是否添加水印'),
  responseFormat: Schema.union([
    Schema.const('b64_json').description('b64_json'),
    Schema.const('url').description('url'),
  ] as const)
    .default('b64_json')
    .description('返回格式'),
  dailySuccessLimit: Schema.number().min(1).max(10000).step(1)
    .default(20)
    .description('每日成功图片限额'),
  withResultDetails: Schema.boolean()
    .default(false)
    .description('是否额外返回本次调用详情'),
}).description('独立模式配置')

const ChatlunaSchema: Schema<ChatlunaConfig> = Schema.object({
  enabled: Schema.boolean()
    .default(false)
    .description('是否启用 ChatLuna 模式（需已安装 chatluna 与 chatluna-doubao-adapter）'),
  modelId: Schema.string()
    .default('doubao-seedream-4-5-251128')
    .description('图片生成模型 ID'),
  enableWebSearch: Schema.boolean()
    .default(false)
    .description('是否启用联网搜索（仅对 doubao-seedream-5-0 系列生效）'),
  size: Schema.string()
    .default('4K')
    .description('默认输出尺寸。支持分辨率档位（如 `2K`）或宽高像素值（如 `2048x1024`）；仅在运行时按模型限制校验').hidden(),
  optimizePromptMode: Schema.union([
    Schema.const('standard').description('standard'),
    Schema.const('fast').description('fast'),
  ] as const)
    .default('standard')
    .description('提示词优化模式（不暴露给工具，仅作为内部默认值）').hidden(),
  watermark: Schema.boolean()
    .default(false)
    .description('是否添加水印（不暴露给工具，仅作为内部默认值）').hidden(),
  toolDescription: Schema.string().role('textarea')
    .default('Generate or transform images using the Doubao Seedream model. Call this tool when you want to create, draw, paint, or modify images. You can optionally attach the current character preset reference image for style-consistent generation.')
    .description('工具描述（供大模型理解工具用途）'),
  presetsDir: Schema.string()
    .default('doubao-image-generation/presets')
    .description('人设参考图存放目录（相对于 data 目录）'),
}).description('ChatLuna 模式配置')

const QuotaSchema: Schema<QuotaConfig> = Schema.object({
  dailyImageLimit: Schema.number().min(0).max(10000).step(1)
    .default(0)
    .description('插件级每日图片生成限额。设为 0 时沿用独立模式 dailySuccessLimit'),
}).description('共享限额配置')

const OpenAICompatibleModelSchema = Schema.union([
  Schema.const('auto').description('auto'),
  Schema.const('gpt-5-3-mini').description('gpt-5-3-mini'),
  Schema.const('gpt-5-4-t-mini').description('gpt-5-4-t-mini'),
  Schema.const('gpt-5-5').description('gpt-5-5'),
  Schema.const('gpt-5-5-instant').description('gpt-5-5-instant'),
  Schema.const('gpt-5-5-mini').description('gpt-5-5-mini'),
  Schema.const('gpt-5-5-thinking').description('gpt-5-5-thinking'),
  Schema.const('gpt-5-6').description('gpt-5-6'),
  Schema.const('gpt-5-6-instant').description('gpt-5-6-instant'),
  Schema.const('gpt-5-6-mini').description('gpt-5-6-mini'),
  Schema.const('gpt-5-6-t-mini').description('gpt-5-6-t-mini'),
  Schema.const('gpt-5-6-thinking').description('gpt-5-6-thinking'),
  Schema.const('gpt-5.5-wm').description('gpt-5.5-wm'),
  Schema.const('gpt-5.6-luna-wm').description('gpt-5.6-luna-wm'),
  Schema.const('gpt-5.6-sol-wm').description('gpt-5.6-sol-wm'),
  Schema.const('gpt-5.6-terra-wm').description('gpt-5.6-terra-wm'),
  Schema.const('o3').description('o3'),
  Schema.const('research').description('research'),
  Schema.const('gpt-image-2').description('gpt-image-2'),
] as const)

const OpenAICompatibleSchema: Schema<OpenAICompatibleConfig> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用 OpenAI 兼容接口配置。开启后，此处配置将覆盖独立模式和 ChatLuna 图片工具的 ARK API 实现'),
  }),
  Schema.union([
    Schema.object({
      enabled: Schema.const(true).required(),
      baseURL: Schema.string()
        .default('http://127.0.0.1:8000/v1')
        .description('OpenAI 兼容接口 Base URL'),
      apiKey: Schema.string().role('secret')
        .required()
        .description('OpenAI 兼容接口 API Key'),
      modelId: OpenAICompatibleModelSchema
        .default('gpt-image-2')
        .description('模型 ID'),
      size: Schema.string()
        .default('auto')
        .description('输出尺寸'),
      n: Schema.number().min(1).max(4).step(1)
        .default(1)
        .description('每次生成图片数量（1～4）'),
      quality: Schema.string()
        .default('auto')
        .description('图片质量，直接传递给兼容接口，默认 auto'),
      responseFormat: Schema.union([
        Schema.const('b64_json').description('b64_json'),
        Schema.const('url').description('url'),
      ] as const)
        .default('b64_json')
        .description('返回格式。建议使用始终可用的 b64_json；url 仅在服务端相应配置启用时返回'),
      dailySuccessLimit: Schema.number().min(1).max(10000).step(1)
        .default(20)
        .description('兼容接口独立的每日成功图片限额。共享限额大于 0 时仍由共享限额统一覆盖'),
      withResultDetails: Schema.boolean()
        .default(false)
        .description('是否额外返回兼容接口本次调用详情'),
    }),
    Schema.object({}),
  ]),
]).description('OpenAI 兼容接口配置')

export const Config: Schema<Config> = Schema.object({
  standalone: StandaloneSchema,
  chatluna: ChatlunaSchema,
  quota: QuotaSchema,
  openAICompatible: OpenAICompatibleSchema,
})

export function resolveDailyLimit(config: Config): number {
  const shared = Number(config.quota?.dailyImageLimit || 0)
  if (Number.isFinite(shared) && shared > 0) return Math.floor(shared)
  if (config.openAICompatible?.enabled) {
    const compatibleLimit = Number(config.openAICompatible.dailySuccessLimit || 0)
    if (Number.isFinite(compatibleLimit) && compatibleLimit > 0) return Math.floor(compatibleLimit)
  }
  return config.standalone.dailySuccessLimit
}
