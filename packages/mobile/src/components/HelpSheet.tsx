// SPDX-License-Identifier: GPL-3.0-only
import React, { useContext, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, ModalPage, Theme, s } from './ui';
export type HelpTopic =
  'copy' | 'verify' | 'connect' | 'projects' | 'recovery' | 'reports';
const chapters: { id: HelpTopic; title: string; steps: string[] }[] = [
  {
    id: 'copy',
    title: '本机选盘与拷贝',
    steps: [
      '素材盘连接在手机上。先选择来源文件夹，再选择目标1与可选目标2；拷贝目标需要独立磁盘。',
      '在系统文件夹选择器侧栏选择磁盘，再进入项目文件夹；通过选择器菜单新建目标文件夹。',
      '授予所需目录与存储权限，检测拷贝支持。开始前核对执行设备、磁盘及完整目录。',
      '目标已有文件不会覆盖；写入后独立重读校验，通过后提交最终名称。',
    ],
  },
  {
    id: 'verify',
    title: '只读校验',
    steps: [
      '选择来源与已经存在的备份目录，再切换“仅校验”。',
      '应用只读取并比较文件，不写入来源或目标素材；不需要全部文件访问。',
      '核对执行设备与目录后开始。不一致会标记失败，请查看任务详情及报告。',
    ],
  },
  {
    id: 'connect',
    title: '扫码连接电脑',
    steps: [
      '手机和电脑连接同一局域网。电脑设置 → 移动端协作 → 开启服务。',
      '在电脑授权来源与目标目录，生成短期二维码。手机切换电脑监控 → 设置 → 扫码连接电脑。',
      '核对电脑名称和配对信息后确认。无法使用相机时，展开手动配对并粘贴配对信息。',
      '素材与磁盘留在电脑。断线时电脑任务继续；手机显示最后更新时间并在网络恢复后重连。地址或证书改变需重新扫码。',
    ],
  },
  {
    id: 'projects',
    title: '母项目与拍摄人员',
    steps: [
      '项目列表中选择新建或编辑母项目，填写拍摄日期、摄影机和备注。',
      '点击“管理人员”，通过姓名或职位搜索。每次添加或编辑一人，职位支持常用建议和自定义；镜头资料采用相同方式。',
      '单项保存先加入编辑草稿，最后点击“保存母项目”。移除资料可在母项目保存前撤销。',
      '工作台选择母项目，再填写本张卡号和本次备注。每次任务保存当时资料，之后修改母项目不改变旧任务和旧报告。',
      '手机与电脑项目分别保存；复制创建新项目，不覆盖同名项目。',
    ],
  },
  {
    id: 'recovery',
    title: '锁屏与中断恢复',
    steps: [
      '本机设置中检查通知权限和系统电池限制。任务由原生前台服务执行；运行期间可锁屏或切换应用。',
      '不要拔盘或强行停止应用。系统后台时限、进程结束或授权失效后，任务显示“等待恢复”。',
      '重新连接磁盘、恢复目录授权，检查来源和目标后继续。已验证文件保留，未完成文件重新处理。',
      '电脑任务无需手机常驻。不同手机厂商的后台管理不同，不能保证应用永不被系统结束。',
    ],
  },
  {
    id: 'reports',
    title: '报告与常见问题',
    steps: [
      '任务结束后查看报告；每次保存生成新修订，历史报告保持原样。',
      '目标空间不足：更换容量足够的盘。目录失效：重新授权。连接失败：检查局域网、协作服务、防火墙和二维码有效期。',
      '内测版仍需真机外置盘验收，不应作为现场唯一备份。',
    ],
  },
];
const welcome = [
  [
    '选择执行设备',
    '本机拷贝使用手机连接的素材盘；电脑监控使用电脑上的磁盘，电脑负责执行。',
  ],
  [
    '管理项目与核对目录',
    '母项目保存拍摄人员和镜头资料。开始前核对执行设备、来源与目标，素材来源始终只读。',
  ],
  [
    '查看进度与安全恢复',
    '任务页显示进度及恢复入口。设置中的离线教程可随时重看。',
  ],
];
export function HelpSheet({
  onClose,
  first = false,
  initialTopic,
}: {
  onClose: () => void;
  first?: boolean;
  initialTopic?: HelpTopic;
}) {
  const { colors: c } = useContext(Theme);
  const [topic, setTopic] = useState<HelpTopic | undefined>(initialTopic),
    [step, setStep] = useState(0);
  const chapter = chapters.find(item => item.id === topic);
  return (
    <ModalPage
      title={first ? '欢迎使用 SecureReel' : (chapter?.title ?? '使用教程')}
      onClose={onClose}
      footer={
        first ? (
          <View style={{ gap: 8 }}>
            <Button
              primary
              label={step === 2 ? '开始使用' : '下一步'}
              onPress={() => (step === 2 ? onClose() : setStep(step + 1))}
            />
            <Button label="跳过引导" onPress={onClose} />
          </View>
        ) : chapter ? (
          <Button label="返回教程目录" onPress={() => setTopic(undefined)} />
        ) : undefined
      }
    >
      {first ? (
        <Card title={`${step + 1} / 3 · ${welcome[step][0]}`}>
          <Text style={[s.body, { color: c.ink }]}>{welcome[step][1]}</Text>
        </Card>
      ) : chapter ? (
        <View style={{ gap: 16 }}>
          {chapter.steps.map((body, i) => (
            <Card key={i} title={`步骤 ${i + 1}`}>
              <Text selectable style={[s.body, { color: c.ink }]}>
                {body}
              </Text>
            </Card>
          ))}
        </View>
      ) : (
        <>
          <Text style={[s.body, { color: c.muted }]}>
            离线教程 · 选择你需要了解的操作
          </Text>
          {chapters.map(item => (
            <Button
              key={item.id}
              label={item.title}
              accessibilityLabel={'教程 ' + item.title}
              onPress={() => setTopic(item.id)}
            />
          ))}
        </>
      )}
    </ModalPage>
  );
}
