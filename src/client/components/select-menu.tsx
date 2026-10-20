import React, { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, MagnifyingGlassIcon } from '@radix-ui/react-icons'
export interface SelectOption { value: string; label: string; description?: string }
export function SelectMenu({ id, label, value, options, onChange, placeholder = '请选择', disabled = false, searchable = false, className = '', align = 'left' }: {
  id: string; label: string; value: string; options: SelectOption[]; onChange: (value: string) => void
  placeholder?: string; disabled?: boolean; searchable?: boolean; className?: string; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null)
  const selected = options.find(option => option.value === value)
  const filtered = options.filter(option => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus() }
  const choose = (next: string) => { onChange(next); close(true) }
  useEffect(() => {
    if (!open) return
    setQuery(''); setActive(Math.max(0, options.findIndex(option => option.value === value)))
    if (searchable) search.current?.focus()
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close() }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { root.current?.querySelector(`#${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active, open, query])
  function keyboard(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      else setActive(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (open && event.key === 'Enter') { event.preventDefault(); if (filtered[active]) choose(filtered[active].value) }
  }
  return <div ref={root} className={`air-select-menu ${className} ${open ? 'is-open' : ''}`} onKeyDown={keyboard} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close() }}>
    <button id={id} type="button" className="air-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox" aria-activedescendant={open && !searchable && filtered[active] ? `${id}-option-${active}` : undefined} ref={trigger} disabled={disabled} onClick={() => setOpen(previous => !previous)}>
      <span><span className="air-select-value">{selected?.label || placeholder}</span>{selected?.description && <small>{selected.description}</small>}</span><ChevronDownIcon aria-hidden="true" />
    </button>
    {open && <div className={`air-select-popover align-${align}`}>
      {searchable && <div className="air-select-search"><MagnifyingGlassIcon aria-hidden="true" /><input ref={search} value={query} aria-label={`搜索${label}`} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={filtered[active] ? `${id}-option-${active}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0) }} placeholder="搜索职位名称、部门或城市" /></div>}
      <div role="listbox" aria-label={label} id={`${id}-list`} className="air-select-options">{filtered.map((option, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} key={option.value} aria-selected={value === option.value} className={active === index ? 'is-active' : ''} onPointerMove={() => setActive(index)} onClick={() => choose(option.value)}><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>{value === option.value && <CheckIcon aria-hidden="true" />}</button>)}{!filtered.length && <p className="air-select-no-results">没有匹配的选项</p>}</div>
    </div>}
  </div>
}
