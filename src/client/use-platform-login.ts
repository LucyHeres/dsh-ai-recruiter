import { useCallback, useEffect, useRef, useState } from 'react'
import type { Platform } from '../shared/workbench.js'
import type { TaskFormProps } from './task-forms.js'

type LoginState = { platform: Platform; status: string; detail: string; phase: 'checking' | 'checked' | 'failed' }

/** Detect each selected platform once it can acquire the browser, including after an initial lock. */
export function usePlatformLogin(platform: Platform, ready: boolean, locked: boolean, checkLogin: TaskFormProps['checkLogin']) {
  const [result, setResult] = useState<LoginState>()
  const checker = useRef(checkLogin)
  checker.current = checkLogin
  const request = useRef(0)
  const attempted = useRef<Platform>()
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refreshLogin = useCallback(async (open: boolean) => {
    if (!ready) return
    const generation = ++request.current
    attempted.current = platform
    setResult({ platform, status: 'unknown', detail: '正在检测登录状态', phase: 'checking' })
    try {
      const value = await checker.current(platform, open)
      if (mounted.current && generation === request.current) setResult({ ...value, platform, phase: 'checked' })
    } catch (error) {
      if (!mounted.current || generation !== request.current) return
      const message = error instanceof Error ? error.message : '请重试'
      setResult({ platform, status: 'unknown', detail: `登录状态读取失败：${message.replace(/https?:\/\/\S+/g, '[地址]').slice(0, 180)}`, phase: 'failed' })
    }
  }, [platform, ready])

  useEffect(() => {
    if (!ready) {
      attempted.current = undefined
      request.current++
      setResult(undefined)
      return
    }
    // A check reserves the browser and temporarily locks the form itself. Do not loop on that lock.
    if (!locked && attempted.current !== platform) void refreshLogin(false)
  }, [platform, ready, locked, refreshLogin])

  const login = ready && result?.platform === platform ? result : undefined
  const checking = login?.phase === 'checking'
  const status = checking ? 'unknown' : login?.status ?? 'unknown'
  const label = checking ? '检测中…' : !ready ? '浏览器扩展未链接' : status === 'logged_in' ? '已登录'
    : status === 'logged_out' ? '未登录' : login?.phase === 'failed' ? '检测失败' : login ? '无法确认' : '待检测'
  return { status, label, checking, detail: login?.detail ?? (!ready ? '请先连接浏览器' : '浏览器空闲后自动检测登录状态'),
    showDetail: !!login && !checking && status === 'unknown', refreshLogin }
}
