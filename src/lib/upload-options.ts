import { z } from 'zod'
import type { XinClient } from './xin-client.js'
import type { ResumeOptions } from '../shared/workbench.js'

const channelsSpec = z.array(z.object({ channelType: z.number().int().nonnegative(), channelDesc: z.string().trim().min(1), openStatus: z.number().int() }))
/** 按主系统上传页的真实渠道列表和 openStatus 取值读取，不让模型猜业务 ID。 */
export async function readUploadChannels(xin: XinClient, signal?: AbortSignal): Promise<ResumeOptions['channels']> {
  const result = await xin.call('channelList', { status: 0 }, signal)
  if (!result.ok) throw new Error(`来源渠道读取失败：${result.failure.message}`)
  const parsed = channelsSpec.safeParse(result.data)
  if (!parsed.success) throw new Error('来源渠道列表格式不可识别')
  const channels = [...new Map(parsed.data.filter(row => row.openStatus === 0).map(row => [row.channelType, {
    id: String(row.channelType), label: row.channelDesc, channelType: row.channelType,
    ...(row.channelType === 20 ? { requires: 'recommenderId' } : row.channelType === 34 ? { requires: 'headhunterSupplierId' } : {}),
  }])).values()]
  // 渠道设置列表通常只列出显式开启的渠道，不包含系统默认渠道（0）；上传页仍可传 0。
  // 固定把「默认渠道」放在第一项，保证表单默认选中值始终存在，而不是悄悄落到别的渠道。
  return channels.some(row => row.channelType === 0)
    ? channels
    : [{ id: '0', label: '默认渠道', channelType: 0 }, ...channels]
}
