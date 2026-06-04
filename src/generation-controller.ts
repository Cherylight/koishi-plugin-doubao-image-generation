export interface DailyUsageSnapshot {
  date: string
  successCount?: number
  webSearchCount?: number
  reservedCount?: number
  apiRequestedCount?: number
  apiGeneratedCount?: number
  messageSentCount?: number
  sendFailedCount?: number
}

export interface QuotaStore {
  getToday(): Promise<DailyUsageSnapshot>
  saveToday(row: DailyUsageSnapshot): Promise<void>
}

export interface QuotaReservation {
  reservedUnits: number
}

export interface GenerationResult {
  data?: Array<{ b64_json?: string; url?: string; error?: any }>
  usage?: any
  error?: any
}

export interface GenerationRunInput {
  prompt: string
  images?: string[]
  responseFormat: string
  quotaUnits: number
  dailyLimit: number
  dedupeKey?: string
  lockKey?: string
  generate: () => Promise<GenerationResult>
  sendResult?: (result: GenerationResult) => Promise<number>
  webSearchUsage?: (result: GenerationResult) => number
}

export interface GenerationRunOutput {
  status: 'ok' | 'quota_exceeded' | 'busy' | 'duplicate' | 'no_image' | 'send_failed'
  result?: GenerationResult
  generatedCount: number
  sentCount: number
  message: string
  error?: unknown
}

interface KeyedMutexState {
  tail: Promise<void>
}

function toCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

export function normalizeUsageRow(row: DailyUsageSnapshot): Required<DailyUsageSnapshot> {
  return {
    date: row.date,
    successCount: toCount(row.successCount),
    webSearchCount: toCount(row.webSearchCount),
    reservedCount: toCount(row.reservedCount),
    apiRequestedCount: toCount(row.apiRequestedCount),
    apiGeneratedCount: toCount(row.apiGeneratedCount ?? row.successCount),
    messageSentCount: toCount(row.messageSentCount ?? row.successCount),
    sendFailedCount: toCount(row.sendFailedCount),
  }
}

export function getGeneratedImageCount(result: GenerationResult, responseFormat: string): number {
  const data = Array.isArray(result?.data) ? result.data : []
  return data.filter((item) => {
    if (responseFormat === 'url') return Boolean(item?.url)
    if (responseFormat === 'b64_json') return Boolean(item?.b64_json)
    return Boolean(item?.b64_json || item?.url)
  }).length
}

export function resolveSessionLockKey(session: any, conversationId?: string): string {
  const platform = String(session?.platform || 'unknown')
  if (session?.isDirect) {
    const userId = session?.userId
    if (userId) return `${platform}:direct:${userId}`
  }
  const channelId = session?.channelId
  if (channelId) return `${platform}:channel:${channelId}`
  const userId = session?.userId
  if (userId) return `${platform}:direct:${userId}`
  if (conversationId) return `conversation:${conversationId}`
  return 'global'
}

export function buildDedupeKey(scopeKey: string, prompt: string, extra = ''): string {
  return `${scopeKey}:${prompt.trim()}:${extra}`
}

export class QuotaManager {
  private mutexes = new Map<string, KeyedMutexState>()

  constructor(private store: QuotaStore) {}

  async reserve(limit: number, units: number): Promise<{ ok: boolean; message?: string; reservation?: QuotaReservation }> {
    const quotaUnits = Math.max(1, Math.floor(units))
    return this.withMutex('quota', async () => {
      const row = normalizeUsageRow(await this.store.getToday())
      const used = row.apiGeneratedCount + row.reservedCount
      if (used + quotaUnits > limit) {
        return { ok: false, message: '今日图片生成限额已用尽' }
      }

      row.reservedCount += quotaUnits
      row.apiRequestedCount += 1
      await this.store.saveToday(row)
      return { ok: true, reservation: { reservedUnits: quotaUnits } }
    })
  }

  async settle(reservation: QuotaReservation, generatedCount: number, sentCount: number, webSearchCount = 0) {
    await this.withMutex('quota', async () => {
      const row = normalizeUsageRow(await this.store.getToday())
      const generated = Math.max(0, Math.floor(generatedCount))
      const sent = Math.max(0, Math.floor(sentCount))
      const reserved = Math.max(0, Math.floor(reservation.reservedUnits))

      row.reservedCount = Math.max(0, row.reservedCount - reserved)
      row.apiGeneratedCount += generated
      row.messageSentCount += Math.min(sent, generated)
      row.sendFailedCount += Math.max(0, generated - sent)
      row.successCount = row.messageSentCount
      row.webSearchCount += Math.max(0, Math.floor(webSearchCount))
      await this.store.saveToday(row)
    })
  }

  async release(reservation: QuotaReservation) {
    await this.withMutex('quota', async () => {
      const row = normalizeUsageRow(await this.store.getToday())
      row.reservedCount = Math.max(0, row.reservedCount - reservation.reservedUnits)
      await this.store.saveToday(row)
    })
  }

  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.mutexes.get(key) || { tail: Promise.resolve() }
    const previous = current.tail
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    current.tail = next
    this.mutexes.set(key, current)

    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.mutexes.get(key) === current && current.tail === next) {
        this.mutexes.delete(key)
      }
    }
  }
}

export class GenerationController {
  private inFlight = new Set<string>()
  private dedupe = new Map<string, number>()

  constructor(
    private quota: QuotaManager,
    private options: { dedupeTtlMs?: number; now?: () => number } = {},
  ) {}

  async run(input: GenerationRunInput): Promise<GenerationRunOutput> {
    const now = this.options.now || Date.now
    const dedupeTtlMs = this.options.dedupeTtlMs ?? 60_000
    this.cleanupDedupe(now())

    if (input.dedupeKey && (this.dedupe.get(input.dedupeKey) || 0) > now()) {
      return {
        status: 'duplicate',
        generatedCount: 0,
        sentCount: 0,
        message: '短时间内已处理过相同图片生成请求，已跳过重复调用。',
      }
    }

    const lockKey = input.lockKey
    if (lockKey) {
      if (this.inFlight.has(lockKey)) {
        return {
          status: 'busy',
          generatedCount: 0,
          sentCount: 0,
          message: '已有图片生成任务进行中，请稍后再试。',
        }
      }
      this.inFlight.add(lockKey)
    }

    let reservation: QuotaReservation | undefined
    try {
      const reserved = await this.quota.reserve(input.dailyLimit, input.quotaUnits)
      if (!reserved.ok || !reserved.reservation) {
        return {
          status: 'quota_exceeded',
          generatedCount: 0,
          sentCount: 0,
          message: reserved.message || '今日图片生成限额已用尽',
        }
      }
      reservation = reserved.reservation

      const result = await input.generate()
      const generatedCount = getGeneratedImageCount(result, input.responseFormat)
      let sentCount = 0
      let sendError: unknown

      if (input.sendResult) {
        try {
          sentCount = await input.sendResult(result)
        } catch (error) {
          sendError = error
        }
      }

      await this.quota.settle(
        reservation,
        generatedCount,
        sentCount,
        input.webSearchUsage ? input.webSearchUsage(result) : 0,
      )
      reservation = undefined

      if (generatedCount > 0 && input.dedupeKey) {
        this.dedupe.set(input.dedupeKey, now() + dedupeTtlMs)
      }

      if (sendError) {
        return {
          status: 'send_failed',
          result,
          generatedCount,
          sentCount,
          message: '图片已生成，但发送给用户失败。',
          error: sendError,
        }
      }

      if (generatedCount <= 0) {
        return {
          status: 'no_image',
          result,
          generatedCount,
          sentCount,
          message: '未返回可用图片',
        }
      }

      return {
        status: 'ok',
        result,
        generatedCount,
        sentCount,
        message: `图片生成成功，已发送 ${sentCount} 张图片给用户。`,
      }
    } catch (error) {
      if (reservation) await this.quota.release(reservation)
      throw error
    } finally {
      if (lockKey) this.inFlight.delete(lockKey)
    }
  }

  private cleanupDedupe(now: number) {
    for (const [key, expiresAt] of this.dedupe) {
      if (expiresAt <= now) this.dedupe.delete(key)
    }
  }
}
