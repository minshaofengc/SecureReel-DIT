/**
 * 离线 HTML 报告。
 *
 * 要求是**自包含**：样式内联、不引用任何外部资源，拷到 U 盘、
 * 十年后在没有网络的老机器上双击也能正常打开。
 * 因此这里不引入任何字体、脚本或图片外链；缩略图用相对路径
 * 指向同目录的 frames/。
 */
import type {
  CopyJob,
  CopyJobFile,
  FrameSource,
  JobState,
  ProjectInfo,
  ReportSummary,
  TargetProgress
} from '@shared/types'
import { clockDuration, humanBytes, humanDuration, percent } from '@shared/format'
import { escapeXml } from './manifests'

/** 任务状态的中文说明，写进报告正文。 */
const JOB_STATE_TEXT: Record<JobState, string> = {
  draft: '草稿（尚未开始）',
  queued: '排队中',
  running: '进行中（报告为中途快照）',
  paused: '已暂停（报告为暂停时刻的快照）',
  completed: '已完成',
  'completed-with-errors': '已完成（部分文件未通过校验）',
  failed: '执行失败',
  cancelled: '已取消'
}

export interface HtmlReportContext {
  summary: ReportSummary
  job: CopyJob
  project: ProjectInfo
  targets: TargetProgress[]
  totalFiles: number
  /** 全部文件（生成器），HTML 里只取前若干条明细 */
  files: AsyncIterable<CopyJobFile>
  /** 最多在 HTML 里展开多少条文件明细 */
  fileRowLimit: number
  hostname: string
  toolName: string
  toolVersion: string
  /** 各目标根目录下清单的相对路径 */
  manifestPaths: string[]
  notes: string[]
}

export async function renderHtmlReport(context: HtmlReportContext): Promise<string> {
  const { summary } = context
  const rows: string[] = []
  const failures: string[] = []
  const probed: string[] = []
  const frames: string[] = []
  const notes = new Set<string>()
  let included = 0
  let total = 0

  for await (const file of context.files) {
    total++
    if (file.state === 'failed') {
      failures.push(
        `<tr><td class="mono">${escapeXml(file.relPath)}</td><td>${humanBytes(file.sizeBytes)}</td><td>${escapeXml(
          file.error ?? '未通过校验'
        )}</td></tr>`
      )
    }

    if (file.probe !== null && file.probe.available) {
      const probe = file.probe
      // 同一句说明在报告里只说一次 —— 五千条素材重复同一段话，
      // 会把真正需要被看到的信息淹掉。
      if (probe.note !== null && probe.note !== '') notes.add(probe.note)

      probed.push(
        `<tr>
          <td class="mono">${escapeXml(file.relPath)}</td>
          <td>${probe.format === null ? '—' : `<span class="fmt">${escapeXml(probe.format)}</span>`}</td>
          <td>${probe.width === null ? '—' : `${probe.width}×${probe.height ?? '?'}`}</td>
          <td>${escapeXml(probe.frameRate ?? '—')}</td>
          <td class="num">${clockDuration(probe.durationSeconds)}</td>
          <td class="mono">${escapeXml(probe.timecode ?? '—')}</td>
          <td class="mono">${escapeXml(probe.capturedAt ?? '—')}</td>
          <td>${frameSourceLabel(probe.frameSource)}</td>
        </tr>`
      )

      // 首帧画面：报告的主体内容之一，单独成画廊
      if (probe.firstFrame !== null) {
        frames.push(
          `<figure class="frame">
            <img src="frames/${encodeURIComponent(probe.firstFrame)}" alt="${escapeXml(file.relPath)}" width="320">
            <figcaption>
              <div class="fname mono">${escapeXml(file.relPath)}</div>
              <div class="fmeta">${probe.format === null ? '' : `${escapeXml(probe.format)} · `}${frameSourceLabel(probe.frameSource)}</div>
            </figcaption>
          </figure>`
        )
      }
    }

    if (included < context.fileRowLimit) {
      rows.push(
        `<tr>
          <td class="mono">${escapeXml(file.relPath)}</td>
          <td class="num">${humanBytes(file.sizeBytes)}</td>
          <td>${stateBadge(file.state)}</td>
          <td class="mono hash">${escapeXml(file.sourceHash ?? '—')}</td>
        </tr>`
      )
      included++
    }
  }

  const targetRows = context.targets
    .map(
      (target) => `<tr>
        <td>${escapeXml(target.label)}</td>
        <td class="num">${humanBytes(target.bytesCopied)}</td>
        <td class="num">${target.filesDone}</td>
        <td class="num ${target.filesFailed > 0 ? 'bad' : ''}">${target.filesFailed}</td>
        <td>${stateBadge(
          target.state === 'completed' ? 'verified' : target.state === 'failed' ? 'failed' : 'copying'
        )}${target.error === null ? '' : `<div class="small bad">${escapeXml(target.error)}</div>`}</td>
      </tr>`
    )
    .join('\n')

  const crewRows =
    context.project.crew.length === 0
      ? '<tr><td colspan="2" class="muted">未填写</td></tr>'
      : context.project.crew
          .map(
            (member) =>
              `<tr><td>${escapeXml(member.role === '' ? '—' : member.role)}</td><td>${escapeXml(
                member.name === '' ? '—' : member.name
              )}</td></tr>`
          )
          .join('\n')

  // 一颗镜头一行。多颗时标上序号，只有一颗时不啰嗦。
  const lenses = context.project.lenses.filter(
    (lens) => lens.model.trim() !== '' || lens.detail.trim() !== ''
  )
  const lensRows = lenses
    .map((lens, index) => {
      const label = lenses.length === 1 ? '镜头' : `镜头 ${index + 1}`
      const value = [lens.model.trim(), lens.detail.trim()].filter((part) => part !== '').join(' ')
      return `    <tr><th>${label}</th><td>${escapeXml(value)}</td></tr>\n`
    })
    .join('')

  const finishedCleanly = summary.jobState === 'completed' || summary.jobState === 'completed-with-errors'
  const headline = !finishedCleanly
    ? `任务未正常结束（${JOB_STATE_TEXT[summary.jobState]}）— 以下为该时刻的实际结果`
    : summary.failedFiles === 0
      ? '全部文件通过校验'
      : `${summary.failedFiles} 个文件未通过校验`

  const interruptionNote = finishedCleanly
    ? ''
    : `<div class="note bad-note">
  本次任务的状态是「${JOB_STATE_TEXT[summary.jobState]}」，不是正常结束。
  报告中未出现的文件不代表已经拷贝完成；请以本文件的失败清单与逐文件记录为准，
  并在恢复任务后重新生成一份新修订。
</div>`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SecureReel DIT 报告 ${escapeXml(summary.revision)} — ${escapeXml(summary.jobName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 40px 32px 64px; max-width: 1040px;
    font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    color: #1c2b26; background: #ffffff; line-height: 1.65; font-size: 14px;
  }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: .01em; }
  h2 { font-size: 16px; margin: 40px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #dcd9d0; }
  .sub { color: #5f6d66; margin: 0 0 28px; }
  .banner { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
  .pill { padding: 6px 12px; border-radius: 999px; font-size: 12px; border: 1px solid #dcd9d0; background: #f7f6f1; }
  .pill.ok { border-color: #9dcfb6; background: #eef7f1; color: #1e6b45; }
  .pill.bad { border-color: #e2b0ad; background: #fdf0ef; color: #a0322c; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  .card { border: 1px solid #dcd9d0; border-radius: 10px; padding: 14px 16px; background: #fbfaf7; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #6b7a72; }
  .card .value { font-size: 17px; margin-top: 4px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eae7e0; vertical-align: top; }
  th { font-weight: 600; color: #4c5a53; background: #f7f6f1; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bad, .bad { color: #a0322c; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .hash { color: #4c5a53; }
  .muted { color: #7d8a83; }
  .small { font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid; }
  .badge.verified { color: #1e6b45; border-color: #9dcfb6; background: #eef7f1; }
  .badge.failed { color: #a0322c; border-color: #e2b0ad; background: #fdf0ef; }
  .badge.copying { color: #7a5a1e; border-color: #ddc48a; background: #fdf6e6; }
  .badge.pending { color: #4c5a53; border-color: #dcd9d0; background: #f7f6f1; }
  .note { border-left: 3px solid #9dcfb6; background: #f4f8f5; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .bad-note { border-left-color: #c8564e; background: #fdf0ef; color: #7d2b26; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 12px; }
  .frame { margin: 0; border: 1px solid #dcd9d0; border-radius: 8px; overflow: hidden; background: #fbfaf7; }
  .frame img { display: block; width: 100%; height: auto; background: #000; }
  .frame figcaption { padding: 8px 10px; }
  .frame .fname { font-size: 11.5px; word-break: break-all; }
  .frame .fmeta { font-size: 11px; color: #6b7a72; margin-top: 3px; }
  .fmt { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid #c9d8ce; background: #f1f7f3; font-size: 11.5px; white-space: nowrap; }
  .src-decoded { color: #1e6b45; }
  .src-preview { color: #8a6a1f; }
  .src-none { color: #7d8a83; }
  @media print { .frame { page-break-inside: avoid; } }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #dcd9d0; color: #7d8a83; font-size: 12px; }
  .truncated { font-size: 12px; color: #7d8a83; margin-top: 8px; }
  @media print { body { padding: 0; max-width: none; } h2 { page-break-after: avoid; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>

<h1>${escapeXml(summary.jobName)}</h1>
<p class="sub">
  SecureReel DIT 拷贝报告 · 修订 ${escapeXml(summary.revision)} ·
  生成于 ${escapeXml(summary.createdAt)} · 主机 ${escapeXml(context.hostname)}
</p>

<div class="banner">
  <span class="pill ${finishedCleanly ? (summary.failedFiles === 0 ? 'ok' : 'bad') : 'bad'}">
    ${escapeXml(headline)}
  </span>
  <span class="pill">任务状态 ${JOB_STATE_TEXT[summary.jobState]}</span>
  <span class="pill">校验算法 ${escapeXml(summary.hashAlgorithm)}</span>
  <span class="pill">清单格式 ${escapeXml(summary.manifestFormat)}</span>
  <span class="pill">目标 ${summary.targets.length} 个</span>
</div>

${interruptionNote}

<h2>总体情况</h2>
<div class="grid">
  <div class="card"><div class="label">来源</div><div class="value">${escapeXml(summary.sourceLabel)}</div>
    <div class="small muted mono">${escapeXml(summary.sourcePath)}</div></div>
  <div class="card"><div class="label">文件总数</div><div class="value">${summary.totalFiles}</div></div>
  <div class="card"><div class="label">总体积</div><div class="value">${humanBytes(summary.totalBytes)}</div></div>
  <div class="card"><div class="label">已校验</div><div class="value">${summary.verifiedFiles}</div>
    <div class="small muted">占 ${percent(summary.verifiedFiles, summary.totalFiles)}%</div></div>
  <div class="card"><div class="label">未通过</div><div class="value ${summary.failedFiles > 0 ? 'bad' : ''}">${summary.failedFiles}</div></div>
  <div class="card"><div class="label">耗时</div><div class="value">${humanDuration(summary.durationSeconds)}</div></div>
</div>

<h2>各目标盘结果</h2>
<table>
  <thead><tr><th>目标</th><th class="num">已写入</th><th class="num">成功</th><th class="num">失败</th><th>状态</th></tr></thead>
  <tbody>
${targetRows}
  </tbody>
</table>

<h2>项目信息</h2>
<table>
  <tbody>
${
  context.project.parentProjectName === null || context.project.parentProjectName === ''
    ? ''
    : `    <tr><th style="width:150px">母项目</th><td><strong>${escapeXml(
        context.project.parentProjectName
      )}</strong></td></tr>\n`
}    <tr><th style="width:150px">项目名称</th><td>${escapeXml(context.project.projectName || '—')}</td></tr>
    <tr><th>拍摄日</th><td>${escapeXml(context.project.shootDay || '—')}</td></tr>
    <tr><th>摄影机</th><td>${escapeXml(context.project.camera || '—')}</td></tr>
${lensRows}    <tr><th>卡号 / 卷号</th><td>${escapeXml(context.project.cardLabel || '—')}</td></tr>
  </tbody>
</table>

<h2>职务与所属人</h2>
<table>
  <thead><tr><th style="width:220px">职务</th><th>所属人</th></tr></thead>
  <tbody>
${crewRows}
  </tbody>
</table>

${
  context.project.notes.trim() === ''
    ? ''
    : `<h2>项目备注</h2>
<div class="note">${escapeXml(context.project.notes).replace(/\n/g, '<br>')}</div>`
}
${
  context.project.copyNotes.trim() === ''
    ? ''
    : `<h2>本次拷贝备注</h2>
<div class="note">${escapeXml(context.project.copyNotes).replace(/\n/g, '<br>')}</div>`
}

<h2>失败清单</h2>
${
  failures.length === 0
    ? '<div class="note">没有任何文件校验失败。所有已写入的目标副本都与源盘逐字节一致。</div>'
    : `<table>
  <thead><tr><th>文件</th><th class="num">大小</th><th>原因</th></tr></thead>
  <tbody>
${failures.join('\n')}
  </tbody>
</table>`
}

<h2>文件明细（${included} / ${total}）</h2>
<table>
  <thead><tr><th>相对路径</th><th class="num">大小</th><th>状态</th><th>校验值（源侧读取时计算）</th></tr></thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>
${
  total > included
    ? `<p class="truncated">为保证报告可快速打开，此处仅展开前 ${included} 条。完整逐文件记录见同目录的 report.json 与清单文件。</p>`
    : ''
}

${
  frames.length === 0
    ? ''
    : `<h2>首帧画面（${frames.length} 条）</h2>
<p class="small muted">
  每张图是该条素材的第一帧。下方标注了画面来源：
  「解码」表示由 FFmpeg 实际解码得到；「内嵌预览」表示该格式为厂商私有编码、
  FFmpeg 无法解码，画面取自摄影机写在文件内部的预览图，分辨率通常低于实际记录分辨率。
</p>
<div class="gallery">
${frames.join('\n')}
</div>`
}

${
  probed.length === 0
    ? ''
    : `<h2>媒体元数据</h2>
<table>
  <thead><tr><th>文件</th><th>格式</th><th>分辨率</th><th>帧率</th><th class="num">时长</th><th>时码</th><th>拍摄时间</th><th>首帧来源</th></tr></thead>
  <tbody>
${probed.join('\n')}
  </tbody>
</table>`
}

${
  notes.size === 0
    ? ''
    : `<h2>素材格式说明</h2>
<ul class="small">
${[...notes].map((note) => `<li>${escapeXml(note)}</li>`).join('\n')}
</ul>`
}

${
  context.manifestPaths.length === 0
    ? ''
    : `<h2>清单文件</h2>
<ul class="small">
${context.manifestPaths.map((item) => `<li class="mono">${escapeXml(item)}</li>`).join('\n')}
</ul>`
}

${
  context.notes.length === 0
    ? ''
    : `<h2>执行说明</h2>
<ul class="small">
${context.notes.map((note) => `<li>${escapeXml(note)}</li>`).join('\n')}
</ul>`
}

<div class="footer">
  <div>由 ${escapeXml(context.toolName)} ${escapeXml(context.toolVersion)} 生成。本报告为不可变归档，同一任务的后续修订会使用新的修订号，不会覆盖本文件。</div>
  <div>校验值算法 ${escapeXml(summary.hashAlgorithm)}；目标副本的校验值由写入完成后**独立重读**目标文件得出，与源侧值逐字节比对通过后才会改名为最终文件名。</div>
  <div>报告生成时间 ${escapeXml(summary.createdAt)}。</div>
</div>

</body>
</html>
`
}

function stateBadge(state: string): string {
  const known = ['verified', 'failed', 'copying', 'pending']
  const cls = known.includes(state) ? state : 'pending'
  const text =
    state === 'verified'
      ? '已校验'
      : state === 'failed'
        ? '失败'
        : state === 'copying'
          ? '进行中'
          : state === 'verifying'
            ? '校验中'
            : '待处理'
  return `<span class="badge ${cls}">${text}</span>`
}

/**
 * 首帧来源标注。
 *
 * 必须如实区分"解码得到的"和"读文件内嵌预览得到的"：
 * 后者分辨率通常低于实际记录分辨率，把它当成原始画质会误导人。
 */
function frameSourceLabel(source: FrameSource): string {
  switch (source) {
    case 'decoded':
      return '<span class="src-decoded">解码</span>'
    case 'embedded-preview':
      return '<span class="src-preview">内嵌预览</span>'
    default:
      return '<span class="src-none">无</span>'
  }
}
