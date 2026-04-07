import { Context } from 'koishi'
import { logger } from './utils'

export interface ContextEntry {
  type: 'text' | 'image'
  content: string
}

export interface UserContext {
  entries: ContextEntry[]
  updatedAt: number
}

const EXPIRE_MS = 60_000

export class ContextManager {
  private store = new Map<string, UserContext>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private _dispose: () => void

  constructor(private ctx: Context) {
    const interval = setInterval(() => this.cleanupExpired(), 30_000)
    this._dispose = () => {
      clearInterval(interval)
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      this.store.clear()
    }
    ctx.on('dispose', this._dispose)
  }

  private makeKey(platform: string, channelId: string, userId: string): string {
    return `${platform}:${channelId}:${userId}`
  }

  get(platform: string, channelId: string, userId: string): UserContext | undefined {
    const key = this.makeKey(platform, channelId, userId)
    const ctx = this.store.get(key)
    if (!ctx) return undefined
    if (Date.now() - ctx.updatedAt > EXPIRE_MS) {
      this.store.delete(key)
      this.clearTimer(key)
      return undefined
    }
    return ctx
  }

  append(platform: string, channelId: string, userId: string, entries: ContextEntry[], onExpire?: () => void): UserContext {
    const key = this.makeKey(platform, channelId, userId)
    const existing = this.store.get(key)
    const now = Date.now()

    let merged: ContextEntry[]
    if (existing && now - existing.updatedAt <= EXPIRE_MS) {
      merged = [...existing.entries, ...entries]
    } else {
      merged = [...entries]
    }

    const userCtx: UserContext = { entries: merged, updatedAt: now }
    this.store.set(key, userCtx)
    this.resetTimer(key, onExpire)
    return userCtx
  }

  clear(platform: string, channelId: string, userId: string): UserContext | undefined {
    const key = this.makeKey(platform, channelId, userId)
    const ctx = this.store.get(key)
    this.store.delete(key)
    this.clearTimer(key)
    return ctx
  }

  getAndClear(platform: string, channelId: string, userId: string): UserContext | undefined {
    const ctx = this.get(platform, channelId, userId)
    if (ctx) this.clear(platform, channelId, userId)
    return ctx
  }

  private resetTimer(key: string, onExpire?: () => void) {
    this.clearTimer(key)
    const timer = setTimeout(() => {
      const ctx = this.store.get(key)
      if (ctx && Date.now() - ctx.updatedAt >= EXPIRE_MS) {
        this.store.delete(key)
        this.timers.delete(key)
        if (onExpire) {
          try { onExpire() } catch (e) { logger.warn('context expire callback error', e) }
        }
      }
    }, EXPIRE_MS + 500)
    this.timers.set(key, timer)
  }

  private clearTimer(key: string) {
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
  }

  private cleanupExpired() {
    const now = Date.now()
    for (const [key, ctx] of this.store) {
      if (now - ctx.updatedAt > EXPIRE_MS) {
        this.store.delete(key)
        this.clearTimer(key)
      }
    }
  }
}
