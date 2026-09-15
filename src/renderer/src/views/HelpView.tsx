import type { ReactNode } from 'react'
import { Card } from '../components/ui'
import { useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

export function HelpView(): ReactNode {
  const { t } = useI18n()
  const { appInfo } = useAppState()

  return (
    <div className="page help">
      <header className="page-head">
        <h2>{t('help.title')}</h2>
        <p>{t('help.intro')}</p>
      </header>

      <Card title={t('help.quickstart')}>
        <ol>
          <li>{t('help.step1')}</li>
          <li>{t('help.step2')}</li>
          <li>{t('help.step3')}</li>
        </ol>
      </Card>

      <Card title={t('help.verify')}>
        <p>{t('help.verifyBody')}</p>
      </Card>

      <Card title={t('help.files')}>
        <p>{t('help.filesBody')}</p>
      </Card>

      <Card title={t('help.overwrite')}>
        <p>{t('help.overwriteBody')}</p>
      </Card>

      <Card title={t('help.manifest')}>
        <p>{t('help.manifestBody')}</p>
      </Card>

      <Card title={t('help.shortcuts')}>
        <section>
          <h3>{t('help.faq1')}</h3>
          <p>{t('help.faq1Body')}</p>
        </section>
        <section>
          <h3>{t('help.faq2')}</h3>
          <p>{t('help.faq2Body')}</p>
        </section>
        <section>
          <h3>{t('help.faq3')}</h3>
          <p>{t('help.faq3Body')}</p>
        </section>
      </Card>

      <Card title={t('help.privacy')}>
        <p>{t('help.privacyBody')}</p>
      </Card>

      <Card title={t('help.about')}>
        <dl className="kv">
          <dt>{t('app.name')}</dt>
          <dd>v{appInfo?.version ?? '—'}</dd>
          <dt>Electron</dt>
          <dd>{appInfo?.electron ?? '—'}</dd>
          <dt>Chrome</dt>
          <dd>{appInfo?.chrome ?? '—'}</dd>
          <dt>Node</dt>
          <dd>{appInfo?.node ?? '—'}</dd>
          <dt>平台</dt>
          <dd>
            {appInfo?.platform ?? '—'} / {appInfo?.arch ?? '—'}
          </dd>
          <dt>许可</dt>
          <dd>GPL-3.0-only</dd>
        </dl>
      </Card>
    </div>
  )
}
