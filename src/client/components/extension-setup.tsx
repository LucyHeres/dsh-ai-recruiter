import React, { useEffect, useRef, useState } from 'react'
import { ArrowTopRightIcon, Cross2Icon, DesktopIcon, ReloadIcon } from '@radix-ui/react-icons'
import { EXTENSION_INSTALL_URL, MINIMUM_EXTENSION_VERSION, type ExtensionInstallation } from '../../shared/workbench.js'
import { EXTENSION_MISSING_MESSAGE, EXTENSION_UPGRADE_MESSAGE, EXTENSION_UNCONFIRMED_MESSAGE, EXTENSION_DESCRIPTION, extensionNeedsSetup, extensionSetupMessage } from '../../shared/connection-status.js'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>

/** Dismissing setup permits browsing; it never queues or resumes a browser task. */
export function useExtensionSetup(installation: ExtensionInstallation | undefined, rpc: Rpc, update: (value: ExtensionInstallation) => void) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const shown = useRef(false)
  const request = useRef<AbortController>()
  const missing = installation?.status === 'not_installed'
  const outdated = installation?.status === 'outdated'
  const unconfirmed = installation?.status === 'unknown'
  const required = extensionNeedsSetup(installation)
  const needsGuide = required || unconfirmed
  const message = extensionSetupMessage(installation)
  useEffect(() => {
    if (needsGuide && !shown.current) { shown.current = true; setOpen(true) }
    if (installation?.status === 'installed') { setOpen(false); setNotice('') }
  }, [installation?.status])
  useEffect(() => () => request.current?.abort(), [])

  async function check() {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setChecking(true); setNotice('')
    try {
      const value = await rpc<ExtensionInstallation>('checkExtension', {}, controller.signal)
      if (controller.signal.aborted) return
      update(value)
      if (value.status === 'installed') setOpen(false)
      else setNotice(value.detail || '暂时无法确认扩展版本，请重试。')
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : '检测失败，请重试。')
    } finally {
      if (!controller.signal.aborted) setChecking(false)
      if (request.current === controller) request.current = undefined
    }
  }
  const show = () => { shown.current = true; setNotice(''); setOpen(true) }
  return {
    required, message, show, check, checking,
    banner: needsGuide && <div className="air-extension-banner" role="status">
      <DesktopIcon aria-hidden="true" /><div><strong>{message}</strong><p>{outdated || unconfirmed ? installation.detail : EXTENSION_DESCRIPTION}</p></div>
      <button type="button" className="air-button air-button-outline air-button-small" onClick={show}>{outdated ? '升级指引' : '安装指引'}</button>
    </div>,
    guide: open && <ExtensionInstallGuide missing={missing} outdated={outdated} unconfirmed={unconfirmed} version={installation?.version} checking={checking} notice={notice || (unconfirmed ? installation.detail : '')} onCheck={() => void check()} onClose={() => setOpen(false)} />,
  }
}

export function ExtensionInstallGuide({ missing, outdated, unconfirmed, version, checking, notice, onCheck, onClose }: { missing: boolean; outdated?: boolean; unconfirmed?: boolean; version?: string; checking: boolean; notice: string; onCheck: () => void; onClose: () => void }) {
  const overlay = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = dialog.current, opener = document.activeElement as HTMLElement | null
    // Block only this plugin's content; the host navigation must remain usable.
    const background = overlay.current?.previousElementSibling as HTMLElement | null
    const wasInert = background?.inert ?? false
    if (background) background.inert = true
    node?.focus({ preventScroll: true })
    return () => {
      if (background) background.inert = wasInert
      if (opener?.isConnected && (node?.contains(document.activeElement) || document.activeElement === document.body)) opener.focus({ preventScroll: true })
    }
  }, [])
  return <div ref={overlay} className="air-workbench air-extension-overlay" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <section ref={dialog} role="dialog" tabIndex={-1} className="air-extension-guide" aria-labelledby="air-extension-guide-title" aria-describedby="air-extension-guide-description">
    <header><span className="air-extension-guide-icon"><DesktopIcon aria-hidden="true" /></span><button type="button" className="air-icon-button" aria-label="关闭安装引导" onClick={onClose}><Cross2Icon aria-hidden="true" /></button></header>
    <h2 id="air-extension-guide-title">{outdated ? EXTENSION_UPGRADE_MESSAGE : unconfirmed ? EXTENSION_UNCONFIRMED_MESSAGE : missing ? EXTENSION_MISSING_MESSAGE : '安装【薪招】浏览器扩展'}</h2>
    <p id="air-extension-guide-description">{EXTENSION_DESCRIPTION}{version ? `当前版本为 ${version}。` : ''}需要 {MINIMUM_EXTENSION_VERSION} 或更高版本。</p>
    {notice && <p className="air-extension-guide-notice" role="status">{notice}</p>}
    <div className="air-extension-guide-actions">
      <a className="air-button air-button-primary" href={EXTENSION_INSTALL_URL} target="_blank" rel="noreferrer">{outdated ? '去升级薪招' : '去安装薪招'}<ArrowTopRightIcon aria-hidden="true" /></a>
      <button type="button" className="air-button air-button-outline" disabled={checking} onClick={onCheck}><ReloadIcon aria-hidden="true" />{checking ? '正在检测…' : outdated ? '已升级，重新检测' : '已安装，重新检测'}</button>
    </div>
    </section>
  </div>
}
