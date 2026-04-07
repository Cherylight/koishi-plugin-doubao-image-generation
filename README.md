# koishi-plugin-doubao-image-generation

基于豆包 Seedream 模型的图片生成插件，支持文生图 / 图生图，可独立使用或作为 ChatLuna 工具供模型调用。

## 功能特性

- **文生图**：输入文字描述即可生成图片
- **图生图**：附带参考图片 + 文字描述生成新图片
- **组图模式**：一次生成多张图片（输入+输出最多 15 张）
- **上下文管理**：通过引用消息逐步构建复杂的生成请求
- **ChatLuna 集成**：注册为 `photo_generation` 工具，支持角色人设图混合生图
- **双模式运行**：独立模式和 ChatLuna 模式互不干扰，可同时启用

## 运行模式

| 模式 | 说明 | 依赖 |
|------|------|------|
| **独立模式** | 直接通过指令使用，需手动配置 API Key 和端点 | `database` |
| **ChatLuna 模式** | 从 `chatluna-doubao-adapter` 继承 API 配置，注册为Chatluna工具 | `chatluna` + `chatluna-doubao-adapter` |

## 指令

### `gen <prompt>`

图片生成主入口。

- 纯文字 → 文生图
- 文字 + 图片 → 图生图

```
gen 一只在月球上散步的橘猫
gen 把这张图变成水彩风格 [附带图片]
```

### `gen-switch`

管理当前频道的图片生成功能开关。

```
gen-switch                    # 查看当前状态
gen-switch --t2i on           # 开启文生图
gen-switch --i2i off          # 关闭图生图
gen-switch --t2i on --i2i on  # 同时开启
```

### `gen-append`

追加图片生成上下文。引用一条消息或直接附带内容，将其加入当前用户的上下文缓冲区。

- 上下文在 60 秒内有效，每次追加刷新计时
- 过期时会发送提醒通知

```
gen-append                 # 引用一条消息时使用
gen-append 赛博朋克风格     # 直接附带文字
gen-append [图片]          # 直接附带图片
```

### `gen-ctx`

管理和使用图片生成上下文。

```
gen-ctx          # 查看当前上下文概况
gen-ctx -c       # 清空上下文
gen-ctx -s       # 以当前上下文发送生成请求
```

## ChatLuna 工具：`photo_generation`

当 ChatLuna 模式启用时，会注册 `photo_generation` 工具供Chatluna调用。该工具专为 `chatluna-character` 角色扮演场景设计。

### 事前准备

将如下内容加入提示词中间以指导模型调用工具:

```YAML
图片生成: photo_generation 工具
        - 适用场景：
          - 用户要求你画画、发照片时，通过该工具生成一张属于你的照片
          - 你想主动发送一张与当前话题相关的图片来活跃气氛时
        - 参数说明：
          - prompt: 详细的图片描述，包含内容、风格、色彩、构图、光影等，不能超过300汉字或600单词
          - use_preset_image: 是否附加你的人设参考图进行图生图，设为 true 时生成的图片会参考你的角色设计保持风格一致
        - 注意事项：
          - 生成的内容需要符合你的人设和当下话题
          - 提示词应当使用第三人称客观描述，如“参考图中人物，生成一张iPhone（前置或后置）自拍照，她穿着（衣着提示，从当前穿搭字段形成），正在（动作描述，从当前日程字段形成）”
          - 可以根据天气，穿搭，日程，心情等多方面构成提示词，提示词应尽量具体和有画面感，避免过于抽象。
          - 当你想画"你自己"或画出与你风格一致的图时，必须设置 use_preset_image 为 true
          - 当使用 use_preset_image 时，提示词必须包含“…参考图中人物…”
          - 图片会由外部服务直接发送给用户，你只会收到成功或失败的状态
          - 不要频繁调用，只在确实需要生成图片的场合使用
```

### 工作方式

- **文生图**：模型传入 prompt 描述，插件直接生成图片并发送给用户
- **人设图混合生图**：模型设置 `use_preset_image: true`，插件自动查找当前角色预设对应的参考图，结合 prompt 进行图生图
- **结果处理**：图片由插件直接发送给用户，只返回成功/失败状态文本给当前模型

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string` | ✅ | 图片的详细文字描述 |
| `use_preset_image` | `boolean` | ❌ | 是否附加当前角色的人设参考图进行图生图（默认 `false`） |

### 返回格式

工具只返回状态文本给 LLM，图片/错误信息由插件直接发送给用户：

```json
{ "success": true, "message": "图片生成成功，已发送 1 张图片给用户。" }
```

```json
{ "success": false, "message": "错误描述" }
```

### 人设参考图设置

插件首次启用 ChatLuna 模式时，会在 `data/doubao-image-generation/presets/` 目录下释放一张示例图片 `img.png`。

**首次使用步骤：**

1. 进入 `data/doubao-image-generation/presets/` 目录
2. **用你的角色人设图替换该文件**
3. 将图片重命名为你的预设文件名，例如：
   - 预设名为 `樱羽艾玛` → 重命名为 `樱羽艾玛.png`
   - 预设名为 `my-character` → 重命名为 `my-character.png`
4. PNG 格式，建议尺寸不小于 512×512，不超过 6000×6000
5. 如果有多个角色预设，你需要为每个预设准备一张同名 PNG 文件

> 预设名即 `chatluna-character` 中配置的预设文件名（不含扩展名）。大模型调用工具时 `use_preset_image: true`，插件会自动查找 `<预设名>.png` 作为参考图。

## 配置参数

### 独立模式 (`standalone`)

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `apiKey` | `string` | — | 火山方舟 API Key（必填） |
| `endpoint` | `string` | `https://ark.cn-beijing.volces.com/api/v3/images/generations` | 图片生成接口地址 |
| `modelId` | `string` | `doubao-seedream-4-5-251128` | 模型 ID |
| `size` | `"2K" \| "4K"` | `4K` | 输出尺寸 |
| `sequentialImageGeneration` | `"disabled" \| "auto"` | `disabled` | 组图功能开关 |
| `sequentialMaxImages` | `number` | `15` | 组图最大数量（1-15） |
| `optimizePromptMode` | `"standard" \| "fast"` | `standard` | 提示词优化模式 |
| `watermark` | `boolean` | `false` | 是否添加水印 |
| `responseFormat` | `"b64_json" \| "url"` | `b64_json` | 返回格式 |
| `dailySuccessLimit` | `number` | `20` | 每日成功图片限额 |
| `withResultDetails` | `boolean` | `false` | 是否额外返回调用详情 |

### ChatLuna 模式 (`chatluna`)

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `false` | 是否启用 |
| `modelId` | `string` | `doubao-seedream-4-5-251128` | 图片生成模型 ID |
| `toolDescription` | `string` | （见下方） | 工具描述（供大模型理解用途） |
| `presetsDir` | `string` | `doubao-image-generation/presets` | 人设参考图存放目录（相对于 data） |

默认工具描述：

> Generate or transform images using the Doubao Seedream model. Call this tool when you want to create, draw, paint, or modify images. You can optionally attach the current character preset reference image for style-consistent generation.

## 许可证

MIT
