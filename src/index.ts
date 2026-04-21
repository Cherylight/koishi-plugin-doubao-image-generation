import { Context, Schema } from 'koishi'
import './types'
import { Config } from './config'
import { DAILY_USAGE_TABLE, IMAGE_SWITCH_TABLE, logger } from './utils'
import { ContextManager } from './context-manager'
import { registerStandaloneCommands } from './commands'
import { registerChatlunaIntegration } from './chatluna-integration'
import zhCN from './locales/zh-CN'

// Re-export config
export { Config } from './config'
export const name = 'doubao-image-generation'
export const inject = {
  required: ['database'],
  optional: ['chatluna'],
}
export const usage = `
## 豆包图片生成

基于豆包 Seedream 模型的图片生成插件，支持文生图/图生图。

- **独立模式**：通过 \`gen\` 命令直接使用，需配置 API Key
- **ChatLuna 模式**：从 chatluna-doubao-adapter 继承配置，注册为 \`photo_generation\` 工具，支持角色人设图混合生图

详见 [README](https://github.com/Cherylight/koishi-plugin-doubao-image-generation) 获取完整文档。
`

export function apply(ctx: Context, config: Config) {
  // Load locales
  ctx.i18n.define('zh-CN', zhCN)

  // Extend database table
  ctx.model.extend(DAILY_USAGE_TABLE, {
    date: 'string',
    successCount: {
      type: 'unsigned',
      initial: 0,
    },
  }, {
    primary: 'date',
  })

  ctx.model.extend(IMAGE_SWITCH_TABLE, {
    channelKey: 'string',
    textToImage: {
      type: 'boolean',
      initial: true,
    },
    imageToImage: {
      type: 'boolean',
      initial: true,
    },
    updatedAt: {
      type: 'unsigned',
      initial: 0,
    },
  }, {
    primary: 'channelKey',
  })

  // Create context manager (in-memory, auto-disposes with plugin)
  const contextManager = new ContextManager(ctx)

  // Register standalone commands (always available)
  registerStandaloneCommands(ctx, config, contextManager)
  logger.info('独立模式指令已注册')

  // Register ChatLuna integration (conditional)
  if (config.chatluna.enabled) {
    // Use ctx.inject to properly handle optional chatluna dependency
    ctx.inject(['chatluna'], (ctx) => {
      registerChatlunaIntegration(ctx, config)
    })
  }
}
