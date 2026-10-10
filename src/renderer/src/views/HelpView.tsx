import type { ReactNode } from 'react'
import { BlockGrid, Card, LeadBlock, PageHead } from '../components/ui'
import { PAGE_INDEX } from '../nav'
import { useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

export function HelpView(): ReactNode {
  const { t } = useI18n()
  const { appInfo } = useAppState()

  return (
    <div className="page help">
      <PageHead
        index={PAGE_INDEX.help}
        kicker={t('nav.help')}
        title={t('help.title')}
        subtitle={t('help.intro')}
      />

      {/*
       * 快速上手单独占整行 —— 它是这一页的入口，用户八成只读这一段。
       * 其余 7 张卡放进BlockGrid 两列，把页面从 8 屏压到 4 屏。
       */}
      <LeadBlock title={t('help.quickstart')}>
        <ol>
          <li>{t('help.step1')}</li>
          <li>{t('help.step2')}</li>
          <li>{t('help.step3')}</li>
        </ol>
      </LeadBlock>

      <BlockGrid>

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
          {/*
            署名放在「关于」里，和版本号同一块。
            名字本身**不走 i18n** —— 人名与院系名不该被翻译，
            走文案表反而会让英文界面里出现一个被改写的名字。
            只有"开发者 / 鸣谢"这两个标签是文案。
          */}
          <dt>{t('help.developer')}</dt>
          <dd>Shanfly 鱼鱼子</dd>
          <dt>{t('help.thanks')}</dt>
          <dd>吉林动画学院电影学院影制系</dd>
          <dt>Electron</dt>
          <dd>{appInfo?.electron ?? '—'}</dd>
          <dt>Chrome</dt>
          <dd>{appInfo?.chrome ?? '—'}</dd>
          <dt>Node</dt>
          <dd>{appInfo?.node ?? '—'}</dd>
          <dt>{t('help.platform')}</dt>
          <dd>
            {appInfo?.platform ?? '—'} / {appInfo?.arch ?? '—'}
          </dd>
          <dt>{t('help.license')}</dt>
          <dd>{t('help.licenseValue')}</dd>
          <dt>{t('help.patent')}</dt>
          <dd>{t('help.patentBody')}</dd>
        </dl>
      </Card>
      </BlockGrid>
    </div>
  )
}
