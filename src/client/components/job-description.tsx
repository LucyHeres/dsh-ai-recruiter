import React, { useMemo } from 'react'
import DOMPurify from 'dompurify'

export function JobDescription({ html }: { html: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  }), [html])
  return <div className="air-job-rich-text" dangerouslySetInnerHTML={{ __html: clean }} />
}
