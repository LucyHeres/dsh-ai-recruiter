import { PLATFORMS, type Platform, type PublishedChannel } from './workbench.js'

/** Display scope and labels; this does not grant an unimplemented browser workflow. */
export const RECRUITMENT_PLATFORMS = {
  lagou: { channelType: 1, label: '拉勾' },
  boss: { channelType: 11, label: 'BOSS直聘' },
  zhilian: { channelType: 2, label: '智联招聘' },
  job51: { channelType: 3, label: '前程无忧' },
  liepin: { channelType: 4, label: '猎聘' },
} as const
export type RecruitmentPlatform = keyof typeof RECRUITMENT_PLATFORMS

export function recruitmentPlatformForChannel(channel: PublishedChannel): RecruitmentPlatform | undefined {
  return (Object.keys(RECRUITMENT_PLATFORMS) as RecruitmentPlatform[]).find(key => String(RECRUITMENT_PLATFORMS[key].channelType) === channel.id)
}

/** UI publishing tags contain only the five recruitment websites, never other sources. */
export function recruitmentPublishedChannels(channels: PublishedChannel[]): PublishedChannel[] {
  const seen = new Set<string>()
  return channels.filter(channel => {
    if (!recruitmentPlatformForChannel(channel) || seen.has(channel.id)) return false
    seen.add(channel.id); return true
  })
}

/** Keep every main-system publishing channel; automation supports only a subset. */
export function sourcingPlatformsForChannels(channels: PublishedChannel[]): Platform[] {
  const ids = new Set(channels.map(channel => channel.id))
  return (Object.keys(PLATFORMS) as Platform[]).filter(platform => ids.has(String(PLATFORMS[platform].channelType)))
}

/** Platform naming is shared by position and candidate tags. */
export function publishedChannelLabel(channel: PublishedChannel): string {
  const key = recruitmentPlatformForChannel(channel)
  return key ? RECRUITMENT_PLATFORMS[key].label : channel.name
}
