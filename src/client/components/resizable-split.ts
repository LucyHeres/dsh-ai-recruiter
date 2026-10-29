import { useEffect, useRef } from 'react'

export const SPLIT_LIST_MIN = 380
export const SPLIT_DETAIL_MIN = 320
const DEFAULT_RATIO = 1.3 / 2.3
const STORAGE_KEY = 'dsh-ai-recruiter:candidate-split-ratio:v1'

/** Pointer frames change only column geometry, without rerendering resumes. */
export function attachResizableSplit(root: HTMLElement, handle: HTMLElement) {
  const view = root.ownerDocument.defaultView
  if (!view) return () => {}
  let ratio = DEFAULT_RATIO
  try {
    const saved = Number(view.localStorage.getItem(STORAGE_KEY))
    if (Number.isFinite(saved) && saved > 0 && saved < 1) ratio = saved
  } catch { /* Storage may be unavailable in an embedded client. */ }
  const persist = () => { try { view.localStorage.setItem(STORAGE_KEY, String(ratio)) } catch {} }
  const paint = (requested?: number) => {
    const available = Math.max(SPLIT_LIST_MIN + SPLIT_DETAIL_MIN, root.clientWidth)
    const left = Math.max(SPLIT_LIST_MIN, Math.min(available - SPLIT_DETAIL_MIN, requested ?? ratio * available))
    root.style.setProperty('--air-list-width', `${left}px`)
    handle.setAttribute('aria-valuemin', String(SPLIT_LIST_MIN))
    handle.setAttribute('aria-valuemax', String(Math.round(available - SPLIT_DETAIL_MIN)))
    handle.setAttribute('aria-valuenow', String(Math.round(left)))
    handle.setAttribute('aria-valuetext', `候选列表 ${Math.round(left)} 像素，简历详情 ${Math.round(available - left)} 像素`)
    return { left, available }
  }
  let drag: { id: number; offset: number; initialRatio: number; cursor: string; selection: string } | undefined
  let frame: number | undefined, pendingX: number | undefined
  const body = root.ownerDocument.body
  const flush = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    frame = undefined
    if (drag && pendingX !== undefined) {
      const size = paint(pendingX - root.getBoundingClientRect().left - root.clientLeft - drag.offset)
      ratio = size.left / size.available
    }
    pendingX = undefined
  }
  const finish = (cancelled: boolean) => {
    if (!drag) return
    flush()
    const previous = drag
    drag = undefined
    if (cancelled) { ratio = previous.initialRatio; paint() }
    else persist()
    root.classList.remove('is-resizing')
    body.style.cursor = previous.cursor
    body.style.userSelect = previous.selection
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id)
  }
  const down = (event: PointerEvent) => {
    if (drag || event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    handle.focus({ preventScroll: true })
    // The transparent hit target overlaps both panes; measure the column edge,
    // rather than the target's offset box, so grabbing either side never jumps.
    const boundary = root.getBoundingClientRect().left + root.clientLeft + paint().left
    drag = { id: event.pointerId, offset: event.clientX - boundary, initialRatio: ratio,
      cursor: body.style.cursor, selection: body.style.userSelect }
    body.style.cursor = 'col-resize'; body.style.userSelect = 'none'
    root.classList.add('is-resizing')
    try { handle.setPointerCapture(event.pointerId) } catch { finish(true) }
  }
  const move = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id) return
    pendingX = event.clientX
    if (frame === undefined) frame = view.requestAnimationFrame(flush)
  }
  const up = (event: PointerEvent) => { if (event.pointerId === drag?.id) finish(false) }
  const cancel = (event: PointerEvent) => { if (event.pointerId === drag?.id) finish(true) }
  const blur = () => finish(true)
  const keyboard = (event: KeyboardEvent) => {
    if (drag) return
    const { left, available } = paint(), step = event.shiftKey ? 50 : 10
    const next = event.key === 'ArrowLeft' ? left - step : event.key === 'ArrowRight' ? left + step
      : event.key === 'Home' ? SPLIT_LIST_MIN : event.key === 'End' ? available - SPLIT_DETAIL_MIN : undefined
    if (next === undefined) return
    event.preventDefault()
    ratio = paint(next).left / available
    persist()
  }
  let observedWidth = root.clientWidth
  const resize = () => {
    if (root.clientWidth === observedWidth) return
    observedWidth = root.clientWidth
    if (drag) finish(true)
    else paint()
  }
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(resize) : undefined
  observer?.observe(root)
  if (!observer) view.addEventListener('resize', resize)
  handle.addEventListener('pointerdown', down)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', cancel)
  handle.addEventListener('lostpointercapture', up)
  handle.addEventListener('keydown', keyboard)
  view.addEventListener('blur', blur)
  paint()
  return () => {
    finish(true)
    observer?.disconnect()
    view.removeEventListener('resize', resize)
    view.removeEventListener('blur', blur)
    handle.removeEventListener('pointerdown', down)
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', cancel)
    handle.removeEventListener('lostpointercapture', up)
    handle.removeEventListener('keydown', keyboard)
    root.style.removeProperty('--air-list-width')
  }
}

export function useResizableSplit(enabled: boolean) {
  const splitRoot = useRef<HTMLDivElement>(null), splitHandle = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (enabled && splitRoot.current && splitHandle.current) return attachResizableSplit(splitRoot.current, splitHandle.current)
  }, [enabled])
  return { splitRoot, splitHandle }
}
