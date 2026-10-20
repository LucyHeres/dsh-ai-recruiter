import React from 'react'
import { RECRUITMENT_PLATFORMS, type RecruitmentPlatform } from '../../shared/published-channels.js'

/** A single tag renderer and palette across the workbench and conversation drawer. */
export function renderPlatformTag(platform: RecruitmentPlatform, options: { key?: string; className?: string; title?: string } = {}) {
  return <span key={options.key} className={`air-platform-tag is-${platform}${options.className ? ` ${options.className}` : ''}`} title={options.title}>{RECRUITMENT_PLATFORMS[platform].label}</span>
}
