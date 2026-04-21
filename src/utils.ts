import { h, Logger } from 'koishi'

export const logger = new Logger('doubao-image-generation')

export const DAILY_USAGE_TABLE = 'doubao_image_daily_usage'
export const IMAGE_SWITCH_TABLE = 'doubao_image_switch'

export const ERROR_CODE_ZH: Record<string, string> = {
  MissingParameter: '请求缺少必要参数，请查阅 API 文档。',
  InvalidParameter: '请求包含非法参数，请查阅 API 文档。',
  'InvalidEndpoint.ClosedEndpoint': '推理接入点已关闭或暂不可用，请稍后重试或联系管理员。',
  InputTextRiskDetection: '输入文本可能包含敏感信息，请更换后重试。',
  InputImageRiskDetection: '输入图片可能包含敏感信息，请更换后重试。',
  OutputTextRiskDetection: '输出文本触发风控，请更换输入内容后重试。',
  OutputImageRiskDetection: '输出图片触发风控，请更换输入内容后重试。',
  ContentSecurityDetectionError: '内容安全检测服务内部错误，请稍后重试。',
  SensitiveContentDetected: '输入文本可能包含敏感信息，请更换 prompt。',
  'SensitiveContentDetected.SevereViolation': '输入文本可能包含严重违规信息，请更换 prompt。',
  'SensitiveContentDetected.Violence': '输入文本可能包含暴力相关信息，请更换 prompt。',
  InputTextSensitiveContentDetected: '输入文本可能包含敏感信息，请更换后重试。',
  InputImageSensitiveContentDetected: '输入图像可能包含敏感信息，请更换后重试。',
  InputVideoSensitiveContentDetected: '输入视频可能包含敏感信息，请更换后重试。',
  OutputTextSensitiveContentDetected: '生成文字可能包含敏感信息，请更换输入内容后重试。',
  OutputImageSensitiveContentDetected: '生成图像可能包含敏感信息，请更换输入内容后重试。',
  OutputVideoSensitiveContentDetected: '生成视频可能包含敏感信息，请更换输入内容后重试。',
  InvalidArgumentError: '请求参数结构不合法，请检查请求字段。',
  'InvalidArgumentError.UnknownRole': '消息 role 不被支持或 inference_role 未定义。',
  'InvalidArgumentError.InvalidImageDetail': 'image detail 参数值无效，仅支持 auto/high/low。',
  'InvalidArgumentError.InvalidPixelLimit': '图片像素限制参数无效（如 min_pixels > max_pixels）。',
  'InvalidImageURL.EmptyURL': '传入的图片 URL/Base64 为空。',
  'InvalidImageURL.InvalidFormat': '图片 URL/Base64 格式错误或数据损坏。',
  OutofContextError: '图片和文本合计 token 超出模型上下文限制。',
  AuthenticationError: '鉴权失败：API Key 无效或缺失。',
  InvalidAccountStatus: '账号状态异常，请联系平台管理员。',
  InvalidSubscription: '套餐未订阅或已过期。',
  AccessDenied: '没有访问该资源的权限，请检查白名单或权限配置。',
  AccountOverdueError: '账号欠费（余额不足），请充值后重试。',
  'OperationDenied.ServiceNotOpen': '模型服务未开通，请在控制台开通后重试。',
  'OperationDenied.ServiceOverdue': '账单逾期，服务不可用，请充值后重试。',
  'OperationDenied.InvalidState': '目标资源状态不可用（如 InProgress），请稍后重试。',
  'OperationDenied.UnsupportedPhase': '目标处于当前不支持操作的阶段。',
  'OperationDenied.FileQuotaExceeded': '文件存储额度已耗尽，请清理历史文件。',
  InvalidEndpointOrModel: '模型或推理接入点不存在，或无访问权限。',
  'InvalidEndpointOrModel.NotFound': '模型或推理接入点不存在，或无访问权限。',
  ModelNotOpen: '当前账号未开通该模型服务。',
  'InvalidEndpointOrModel.ModelIDAccessDisabled': '账号不允许通过 Model ID 调用，请改用 Endpoint ID。',
  UnsupportedModel: '当前模型不支持该功能。',
  'RateLimitExceeded.EndpointRPMExceeded': '推理接入点 RPM 已超限，请稍后重试。',
  'RateLimitExceeded.EndpointTPMExceeded': '推理接入点 TPM 已超限，请稍后重试。',
  ModelAccountRpmRateLimitExceeded: '账户模型 RPM 已超限，请稍后重试。',
  ModelAccountTpmRateLimitExceeded: '账户模型 TPM 已超限，请稍后重试。',
  APIAccountRpmRateLimitExceeded: '账号该接口 RPM 已超限，请稍后重试。',
  ModelAccountIpmRateLimitExceeded: '账户模型 IPM（每分钟图片数）已超限，请稍后重试。',
  QuotaExceeded: '额度不足或排队任务超限，请稍后重试或开通服务。',
  ServerOverloaded: '服务资源紧张，请稍后重试。',
  RequestBurstTooFast: '请求突增触发保护，请放缓流量并逐步提升。',
  SetLimitExceeded: '模型推理限额已达上限，请在控制台调整限额。',
  InflightBatchsizeExceeded: '并发数超过当前上限，请降低并发或充值提升额度。',
  AccountRateLimitExceeded: '请求过于频繁（RPM/TPM 超限），请稍后重试。',
  InternalServiceError: '服务内部异常，请稍后重试。',
}

export function translateErrorCode(code: string): string {
  if (!code) return ''
  if (ERROR_CODE_ZH[code]) return ERROR_CODE_ZH[code]
  const normalized = String(code).split(':')[0].trim()
  if (ERROR_CODE_ZH[normalized]) return ERROR_CODE_ZH[normalized]
  return '未知错误码，请结合原始 message 与 Request ID 排查。'
}

export function normalizeApiError(error: any): { code: string; message: string; zh: string } {
  const bodyError = error?.response?.data?.error
    || error?.data?.error
    || (typeof error?.response?.data === 'string' ? {} : error?.response?.data)
    || {}
  const code = bodyError.code || error?.code || ''
  const message = bodyError.message || error?.message || ''
  return { code, message, zh: translateErrorCode(code) }
}

export function timestampToLocal(created: number | undefined): string {
  if (!created) return '-'
  try {
    return new Date(created * 1000).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(created)
  }
}

export function extractImages(content: string): string[] {
  return h.select(content || '', 'img')
    .map((item) => item?.attrs?.src)
    .filter(Boolean)
}

export function extractText(content: string): string {
  const nodes = h.select(content || '', 'text')
  return nodes
    .map((item) => (item?.attrs?.content || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

export function asDataUri(base64: string, fallbackMime = 'image/png'): string {
  if (!base64) return ''
  if (base64.startsWith('data:image/')) return base64
  return `data:${fallbackMime};base64,${base64}`
}

export function todayKey(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function keepFromDateKey(daysToKeep = 7): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (daysToKeep - 1))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface ImageRules {
  maxInputImages: number
  allowedFormats: string[]
  minRatio: number
  maxRatio: number
}

export function getImageRulesByModel(): ImageRules {
  return {
    maxInputImages: 14,
    allowedFormats: ['jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif'],
    minRatio: 1 / 16,
    maxRatio: 16,
  }
}

// ── Image format detection ──

function readUInt16(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
}

function readUInt32(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

function parseJpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) { offset += 1; continue }
    const marker = buffer[offset + 1]
    if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue }
    if (offset + 4 >= buffer.length) break
    const segmentLength = buffer.readUInt16BE(offset + 2)
    if (segmentLength < 2) break
    const isSof =
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF)
    if (isSof && offset + 9 < buffer.length) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    offset += 2 + segmentLength
  }
  return null
}

function parseWebpSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null
  const chunkType = buffer.toString('ascii', 12, 16)
  if (chunkType === 'VP8X') {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
  }
  if (chunkType === 'VP8L') {
    const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24]
    return {
      width: 1 + (b0 | ((b1 & 0x3F) << 8)),
      height: 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10)) >>> 0),
    }
  }
  if (chunkType === 'VP8 ') {
    const frameStart = 20
    if (buffer.length < frameStart + 10) return null
    if (buffer[frameStart + 3] !== 0x9D || buffer[frameStart + 4] !== 0x01 || buffer[frameStart + 5] !== 0x2A) return null
    return {
      width: buffer.readUInt16LE(frameStart + 6) & 0x3FFF,
      height: buffer.readUInt16LE(frameStart + 8) & 0x3FFF,
    }
  }
  return null
}

function parseTiffSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 16) return null
  const littleEndian = buffer.toString('ascii', 0, 2) === 'II'
  const bigEndian = buffer.toString('ascii', 0, 2) === 'MM'
  if (!littleEndian && !bigEndian) return null
  if (readUInt16(buffer, 2, littleEndian) !== 42) return null
  const ifdOffset = readUInt32(buffer, 4, littleEndian)
  if (ifdOffset + 2 > buffer.length) return null
  const entryCount = readUInt16(buffer, ifdOffset, littleEndian)
  let width: number | null = null
  let height: number | null = null
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12
    if (entryOffset + 12 > buffer.length) break
    const tag = readUInt16(buffer, entryOffset, littleEndian)
    const type = readUInt16(buffer, entryOffset + 2, littleEndian)
    const count = readUInt32(buffer, entryOffset + 4, littleEndian)
    if (count !== 1) continue
    let value: number | null = null
    if (type === 3) value = readUInt16(buffer, entryOffset + 8, littleEndian)
    else if (type === 4) value = readUInt32(buffer, entryOffset + 8, littleEndian)
    if (value == null) continue
    if (tag === 256) width = value
    if (tag === 257) height = value
  }
  return width && height ? { width, height } : null
}

export interface ImageMeta {
  format: string
  mime: string
  width: number
  height: number
}

export function detectImageMeta(buffer: Buffer): ImageMeta | null {
  if (!buffer || buffer.length < 10) return null

  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    if (buffer.length < 24) return null
    return { format: 'png', mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    const size = parseJpegSize(buffer)
    return size ? { format: 'jpeg', mime: 'image/jpeg', ...size } : null
  }
  // GIF
  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') {
    return { format: 'gif', mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // BMP
  if (buffer.toString('ascii', 0, 2) === 'BM') {
    return { format: 'bmp', mime: 'image/bmp', width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) }
  }
  // WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const size = parseWebpSize(buffer)
    return size ? { format: 'webp', mime: 'image/webp', ...size } : null
  }
  // TIFF
  if ((buffer.toString('ascii', 0, 2) === 'II' && buffer[2] === 0x2A && buffer[3] === 0x00)
    || (buffer.toString('ascii', 0, 2) === 'MM' && buffer[2] === 0x00 && buffer[3] === 0x2A)) {
    const size = parseTiffSize(buffer)
    return size ? { format: 'tiff', mime: 'image/tiff', ...size } : null
  }

  return null
}

export function parseDataUri(src: string): { mime: string; base64: string } | null {
  const matched = String(src || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!matched) return null
  return { mime: matched[1].toLowerCase(), base64: matched[2] }
}

export function formatErrorMessage(code: string, message: string): string {
  const zh = translateErrorCode(code)
  return `${code || '-'}${zh ? `（${zh}）` : ''}\n${message || ''}`.trim()
}

export function buildDetailMessage(result: any): string {
  const rows: string[] = []
  rows.push('【图片生成调用结果】')
  rows.push(`模型: ${result?.model || '-'}`)
  rows.push(`时间: ${timestampToLocal(result?.created)}`)
  const data = Array.isArray(result?.data) ? result.data : []
  const sizes = data.map((item: any) => item?.size).filter(Boolean)
  rows.push(`图片宽高: ${sizes.length ? sizes.join(', ') : '-'}`)
  if (result?.usage) {
    rows.push(`用量: generated_images=${result.usage.generated_images ?? '-'}, output_tokens=${result.usage.output_tokens ?? '-'}, total_tokens=${result.usage.total_tokens ?? '-'}`)
  } else {
    rows.push('用量: -')
  }
  if (result?.error) {
    const zh = translateErrorCode(result.error.code)
    rows.push(`错误: ${(result.error.code || '-')}${zh ? `（${zh}）` : ''} ${result.error.message || ''}`.trim())
  } else {
    const dataErrors = data.map((item: any) => item?.error).filter(Boolean)
      .map((err: any) => {
        const zh = translateErrorCode(err.code)
        return `${err.code || '-'}${zh ? `（${zh}）` : ''} ${err.message || ''}`.trim()
      })
    rows.push(`错误: ${dataErrors.length ? dataErrors.join(' | ') : '无'}`)
  }
  return rows.join('\n')
}
