import { z } from 'zod'
import { allowedTab, type PageNavigation } from './page-actions.js'
import { modelPageObservation } from './model-observation.js'
export const MAX_INSPECTION_CHARACTERS = 50000
export const inspectionSchemas = {
  refresh_page: z.object({ format: z.enum(['semantic', 'dom']).optional(), offset: z.number().int().min(0).optional(), maxItems: z.number().int().min(1).max(600).optional() }).strict(),
  read_page: z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100), query: z.string().max(300).optional() }).strict(),
  inspect_element: z.object({ ref: z.string().min(1).max(120) }).strict(),
  read_accessibility: z.object({}).strict(),
  network_requests: z.object({ urlPattern: z.string().max(200).optional() }).strict(),
}
export type InspectionName = keyof typeof inspectionSchemas
export type PageInspector = (name: InspectionName, args: Record<string, unknown>) => Promise<unknown>
export function pageInspector(view: PageNavigation, progress?: (message: string) => Promise<void>): PageInspector {
  let progressQueue = Promise.resolve()
  const labels: Record<InspectionName, string> = { read_page: 'AI 正在补充阅读页面信息', refresh_page: 'AI 正在刷新页面并核对最新控件', inspect_element: 'AI 正在检查当前控件及关联菜单', read_accessibility: 'AI 正在阅读页面结构', network_requests: 'AI 正在检查页面请求状态' }
  return async (name, input) => {
    const args = inspectionSchemas[name].parse(input)
    if (progress) { progressQueue = progressQueue.then(() => progress(labels[name])); await progressQueue }
    const policy = { allowedOrigins: [...view.origins], riskLevel: 'read' }
    switch (name) {
      case 'read_page': {
        const output = modelPageObservation(view.page, inspectionSchemas.read_page.parse(input))
        if (JSON.stringify(output).length > MAX_INSPECTION_CHARACTERS) throw new Error('PAGE_INSPECTION_TOO_LARGE')
        return output
      }
      case 'refresh_page': {
        const snapshot = await view.call('browser_snapshot', { tabId: view.tabId, viewportOnly: true,
          ...inspectionSchemas.refresh_page.parse(input), ...(view.frameId == null ? {} : { frameId: view.frameId }), policy })
        if (!snapshot?.snapshotId || !Array.isArray(snapshot.items)) throw new Error('PAGE_WITHOUT_SNAPSHOT')
        if (!allowedTab({ tabId: view.tabId, url: snapshot.url }, view.origins)) throw new Error('ORIGIN_NOT_ALLOWED')
        const output = modelPageObservation(snapshot)
        if (JSON.stringify(output).length > MAX_INSPECTION_CHARACTERS) throw new Error('PAGE_INSPECTION_TOO_LARGE')
        const updated = { ...snapshot }
        for (const key of Object.keys(view.page)) delete view.page[key]
        Object.assign(view.page, updated)
        return output
      }
      case 'inspect_element': {
        const ref = (args as { ref: string }).ref
        // Inspection is bound to the same task snapshot, including frame ownership.
        if (!view.page.snapshotId || !view.page.items?.some((item: any) => item.ref === ref)) throw new Error('ELEMENT_NOT_FOUND')
        return view.call('browser_inspect_element', { tabId: view.tabId, snapshotId: view.page.snapshotId, documentId: view.page.documentId, ref, policy })
      }
      case 'read_accessibility': return view.call('browser_accessibility', { tabId: view.tabId, ...(view.frameId ? { frameId: view.frameId } : {}), policy })
      case 'network_requests': return view.call('browser_network_requests', { tabId: view.tabId, ...args, policy })
    }
  }
}
