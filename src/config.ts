import { Schema } from 'koishi'

export type ImageSize = '2K' | '4K'
export type SequentialMode = 'disabled' | 'auto'
export type OptimizePromptMode = 'standard' | 'fast'
export type ResponseFormat = 'b64_json' | 'url'

export interface StandaloneConfig {
  apiKey: string
  endpoint: string
  modelId: string
  size: ImageSize
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
  size: ImageSize
  optimizePromptMode: OptimizePromptMode
  watermark: boolean
  toolDescription: string
  presetsDir: string
}

export interface Config {
  standalone: StandaloneConfig
  chatluna: ChatlunaConfig
}

const StandaloneSchema: Schema<StandaloneConfig> = Schema.object({
  apiKey: Schema.string().role('secret').required()
    .description('火山方舟 API Key'),
  endpoint: Schema.string()
    .default('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    .description('图片生成接口完整地址'),
  modelId: Schema.string()
    .default('doubao-seedream-4-5-251128')
    .description('模型 ID'),
  size: Schema.union([
    Schema.const('2K').description('2K'),
    Schema.const('4K').description('4K'),
  ] as const)
    .default('4K')
    .description('输出尺寸'),
  sequentialImageGeneration: Schema.union([
    Schema.const('disabled').description('disabled'),
    Schema.const('auto').description('auto'),
  ] as const)
    .default('disabled')
    .description('组图功能开关'),
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
  size: Schema.union([
    Schema.const('2K').description('2K'),
    Schema.const('4K').description('4K'),
  ] as const)
    .default('4K')
    .description('默认输出尺寸（不暴露给工具，仅作为内部默认值）').hidden(),
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

export const Config: Schema<Config> = Schema.object({
  standalone: StandaloneSchema,
  chatluna: ChatlunaSchema,
})
