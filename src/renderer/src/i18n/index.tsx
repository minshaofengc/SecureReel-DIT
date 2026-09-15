import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { Language } from '@shared/types'
import { en, zhCN, type MessageKey } from './messages'

interface I18nValue {
  language: Language
  t: (key: MessageKey) => string
}

const I18nContext = createContext<I18nValue>({
  language: 'zh-CN',
  t: (key) => zhCN[key]
})

export function I18nProvider({
  language,
  children
}: {
  language: Language
  children: ReactNode
}): ReactNode {
  const t = useCallback(
    (key: MessageKey): string => {
      const table = language === 'en' ? en : zhCN
      return table[key] ?? zhCN[key] ?? key
    },
    [language]
  )

  const value = useMemo(() => ({ language, t }), [language, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

export type { MessageKey }
