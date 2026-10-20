export const safeError = (error: unknown) => {
  // Do not forward gateway URLs, pairing secrets, or raw transport diagnostics.
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https?:\/\/\S+/g, '[地址]').replace(/(?:token|nonce|sessionId|authorization)[=:]\S+/gi, '[凭据]').slice(0, 350)
}
