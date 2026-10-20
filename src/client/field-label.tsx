import React from 'react'
import { QuestionMarkCircledIcon } from '@radix-ui/react-icons'

export function FieldLabel({ htmlFor, children, hint, hintId, invalid = false }: {
  htmlFor: string
  children: string
  hint: string
  hintId: string
  invalid?: boolean
}) {
  return <div className="air-field-label">
    <label className="air-label" htmlFor={htmlFor}>{children}</label>
    <span className={`air-field-help ${invalid ? 'is-invalid' : ''}`}>
      <button type="button" className="air-field-help-trigger" aria-label={`${children}说明`} aria-describedby={hintId}><QuestionMarkCircledIcon aria-hidden="true" /></button>
      <span id={hintId} className="air-field-tooltip" role="tooltip">{hint}</span>
    </span>
  </div>
}
