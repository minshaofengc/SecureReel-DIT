import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { Language } from '@shared/types'
// 占位符替换与主进程共用一份实现，两边的写法不会再漂
import { fillTemplate } from '@shared/messages'
import { en, zhCN, type MessageKey } from './messages'

/** 占位符参数。写法与主进程的 `@shared/messages` 一致：`{name}`。 */
export type TranslateParams = Record<string, string | number>

interface I18nValue {
  language: Language
  /** 取一条界面文案。占位符 `{name}` 由 `params` 替换。 */
  t: (key: MessageKey, params?: TranslateParams) => string
}

/**
 * 在 React 组件之外按指定语言取文案。
 *
 * 用于 AppState 的启动提示这类场景：那时语言设置刚从主进程读回来，
 * 组件树里的 I18nProvider 还没拿到它。拼一句话必须用**设置里的语言**，
 * 否则英文界面下会冒出一整段中文。
 */
export function translate(language: Language, key: MessageKey, params?: TranslateParams): string {
  const table = language === 'en' ? en : zhCN
  return fillTemplate(table[key] ?? zhCN[key] ?? key, params)
}

const I18nContext = createContext<I18nValue>({
  language: 'zh-CN',
  t: (key, params) => translate('zh-CN', key, params)
})

export function I18nProvider({
  language,
  children
}: {
  language: Language
  children: ReactNode
}): ReactNode {
  const t = useCallback(
    (key: MessageKey, params?: TranslateParams): string => translate(language, key, params),
    [language]
  )

  const value = useMemo(() => ({ language, t }), [language, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

export type { MessageKey }
