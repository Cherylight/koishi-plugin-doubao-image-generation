import {} from 'koishi'

declare module 'koishi' {
  interface Tables {
    doubao_image_daily_usage: DailyUsageRow
  }

  interface Context {
    chatluna?: any
  }
}

export interface DailyUsageRow {
  date: string
  successCount: number
}
