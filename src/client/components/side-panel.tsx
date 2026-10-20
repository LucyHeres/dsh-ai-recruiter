import React, { useEffect, useRef } from 'react'
import { Cross2Icon } from '@radix-ui/react-icons'
export function SidePanel({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current, opener = document.activeElement as HTMLElement | null
    node?.showModal()
    return () => { node?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className={`air-side-panel ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}>
    <header><h2>{title}</h2><button type="button" className="air-sourcing-icon-button" aria-label={`关闭${title}`} onClick={onClose}><Cross2Icon aria-hidden="true" /></button></header>{children}
  </dialog>
}
