/** Stable platform vocabulary and entry paths, shared by sourcing and the
 * existing greeting/import workflows. Component selectors stay beside drivers. */
export const liepinDefinition = {
  sourcingEntry: 'https://lpt.liepin.com/recommend',
  sourcingSearchEntry: 'https://lpt.liepin.com/search',
  receivedEntry: 'https://lpt.liepin.com/resume/apply',
  listPaths: ['/recommend', '/search', '/resume/apply'],
  receivedTab: '收到简历',
  greetingLabels: new Set(['立即沟通']),
}
