import React, { useEffect, useRef, useState } from 'react'
import { ArrowTopRightIcon, Cross2Icon, DesktopIcon, ReloadIcon } from '@radix-ui/react-icons'
import { EXTENSION_INSTALL_URL, type ExtensionInstallation } from '../../shared/workbench.js'
import { EXTENSION_MISSING_MESSAGE, EXTENSION_DESCRIPTION } from '../../shared/connection-status.js'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>

/** Dismissing setup permits browsing; it never queues or resumes a browser task. */
export function useExtensionSetup(installation: ExtensionInstallation | undefined, rpc: Rpc, update: (value: ExtensionInstallation) => void) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const shown = useRef(false)
  const request = useRef<AbortController>()
  const missing = installation?.status === 'not_installed'
  useEffect(() => {
    if (missing && !shown.current) { shown.current = true; setOpen(true) }
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
      else setNotice(value.status === 'not_installed' ? EXTENSION_MISSING_MESSAGE : '暂时无法确认安装状态，请重试。')
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : '检测失败，请重试。')
    } finally {
      if (!controller.signal.aborted) setChecking(false)
      if (request.current === controller) request.current = undefined
    }
  }
  const show = () => { shown.current = true; setNotice(''); setOpen(true) }
  return {
    missing, show, check, checking,
    banner: missing && <div className="air-extension-banner" role="status">
      <DesktopIcon aria-hidden="true" /><div><strong>{EXTENSION_MISSING_MESSAGE}</strong><p>{EXTENSION_DESCRIPTION}</p></div>
      <button type="button" className="air-button air-button-outline air-button-small" onClick={show}>安装指引</button>
    </div>,
    guide: open && <ExtensionInstallGuide missing={missing} checking={checking} notice={notice} onCheck={() => void check()} onClose={() => setOpen(false)} />,
  }
}

export function ExtensionInstallGuide({ missing, checking, notice, onCheck, onClose }: { missing: boolean; checking: boolean; notice: string; onCheck: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current, opener = document.activeElement as HTMLElement | null
    node?.showModal()
    return () => { node?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className="air-extension-guide" aria-labelledby="air-extension-guide-title" aria-describedby="air-extension-guide-description" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><span className="air-extension-guide-icon"><DesktopIcon aria-hidden="true" /></span><button type="button" className="air-icon-button" aria-label="关闭安装引导" onClick={onClose}><Cross2Icon aria-hidden="true" /></button></header>
    <h2 id="air-extension-guide-title">{missing ? EXTENSION_MISSING_MESSAGE : '安装【薪招】浏览器扩展'}</h2>
    <p id="air-extension-guide-description">{EXTENSION_DESCRIPTION}</p>
    {notice && <p className="air-extension-guide-notice" role="status">{notice}</p>}
    <div className="air-extension-guide-actions">
      <a className="air-button air-button-primary" href={EXTENSION_INSTALL_URL} target="_blank" rel="noreferrer">去安装薪招<ArrowTopRightIcon aria-hidden="true" /></a>
      <button type="button" className="air-button air-button-outline" disabled={checking} onClick={onCheck}><ReloadIcon aria-hidden="true" />{checking ? '正在检测…' : '已安装，重新检测'}</button>
    </div>
  </dialog>
}
