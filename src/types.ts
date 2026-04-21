import {} from 'koishi'

declare module 'koishi' {
  interface Tables {
    doubao_image_daily_usage: DailyUsageRow
    doubao_image_switch: ImageSwitchRow
  }

  interface Context {
    chatluna?: any
  }
}

export interface DailyUsageRow {
  date: string
  successCount: number
}

export interface ImageSwitchRow {
  channelKey: string
  textToImage: boolean
  imageToImage: boolean
  updatedAt: number
}
