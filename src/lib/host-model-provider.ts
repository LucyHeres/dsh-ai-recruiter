/** Check the host's registered routes before starting a model-dependent task. */
export function assertHostModelProvider(
  llm: { listProviders?: () => readonly { id: string }[] },
  provider: string,
  dedicated = false,
): void {
  if (!llm.listProviders || llm.listProviders().some(item => item.id === provider)) return
  const source = dedicated ? '招聘插件的浏览器专用模型' : '薪灵默认模型'
  const action = dedicated ? '请修改插件的 browserAgentProvider/browserAgentModel，或同时清空以继承宿主默认模型'
    : '请在薪灵的模型设置中重新选择已启用的模型'
  throw new Error(`HOST_MODEL_PROVIDER_UNAVAILABLE: ${source}指向未注册的供应商「${provider}」。${action}；如需继续使用该供应商，请先恢复对应模型适配器`)
}
