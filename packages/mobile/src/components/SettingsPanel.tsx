// SPDX-License-Identifier: GPL-3.0-only
import React, { useContext } from 'react';
import { Text, View } from 'react-native';
import { Button, HelpLink, Card, Theme, s, Input } from './ui';
import { type Settings } from '../projectData';
import { HASHES, compatible, type ManifestFormat } from '../domain';
export function ThemePicker({
  value,
  onChange,
}: {
  value: Settings['themeMode'];
  onChange: (themeMode: Settings['themeMode']) => void;
}) {
  return (
    <Card title="界面主题">
      <View style={s.row}>
        {(['system', 'light', 'dark'] as const).map((themeMode, i) => (
          <Button
            key={themeMode}
            label={['跟随系统', '浅色', '深色'][i]}
            primary={value === themeMode}
            onPress={() => onChange(themeMode)}
          />
        ))}
      </View>
    </Card>
  );
}
export function LocalSettings({
  settings,
  runtime,
  access,
  onChange,
  onPermission,
}: {
  settings: Settings;
  runtime: { notificationsEnabled: boolean; batteryUnrestricted: boolean };
  access: boolean;
  onChange: (change: Partial<Settings>) => void;
  onPermission: (
    kind: 'notifications' | 'battery' | 'refresh' | 'storage',
  ) => void;
}) {
  const { colors: c } = useContext(Theme);
  return (
    <>
      <ThemePicker value={settings.themeMode} onChange={themeMode => onChange({ themeMode })} />
      <Card title="本机任务默认值">
        <Text style={[s.body, { color: c.ink }]}>校验算法</Text>
        <View style={s.row}>
          {HASHES.map(hashAlgorithm => (
            <Button
              key={hashAlgorithm}
              label={hashAlgorithm}
              primary={settings.hashAlgorithm === hashAlgorithm}
              onPress={() => onChange({ hashAlgorithm })}
            />
          ))}
        </View>
        <Text style={[s.body, { color: c.ink }]}>清单格式</Text>
        <View style={s.row}>
          {(['asc-mhl-2.0', 'mhl-v1', 'csv', 'json'] as ManifestFormat[]).map(
            manifestFormat => (
              <Button
                key={manifestFormat}
                label={manifestFormat}
                primary={settings.manifestFormat === manifestFormat}
                disabled={!compatible(manifestFormat, settings.hashAlgorithm)}
                onPress={() => onChange({ manifestFormat })}
              />
            ),
          )}
        </View>
      </Card>
      <Card title="后台运行">
        <Text style={[s.body, { color: c.ink }]}>
          任务通知：{runtime.notificationsEnabled ? '已允许' : '未允许'} ·
          电池限制：{runtime.batteryUnrestricted ? '已放宽' : '受系统管理'}
        </Text>
        <Button
          label="允许任务通知"
          onPress={() => onPermission('notifications')}
        />
        <Button
          label="电池设置"
          onPress={() => onPermission('battery')}
        />
        <Button label="刷新状态" onPress={() => onPermission('refresh')} />
        <Button
          label={'屏幕常亮 · ' + (settings.keepScreenOn ? '开' : '关')}
          primary={settings.keepScreenOn}
          onPress={() => onChange({ keepScreenOn: !settings.keepScreenOn })}
        />
      </Card>
      <Card title="存储权限">
        <Text style={[s.body, { color: c.muted }]}>
          全部文件访问 · {access ? '已允许' : '未允许'} · 素材来源只读
        </Text>
        <Button
          label="设置全部文件访问"
          onPress={() => onPermission('storage')}
        />
      </Card>
    </>
  );
}
export function ConnectionSettings({
  themeMode,
  onThemeChange,
  manual,
  onManualChange,
  paired,
  connected,
  desktopName,
  lastSeen,
  deviceName,
  onDeviceName,
  setup,
  onSetup,
  error,
  onScan,
  onConnect,
  onForget,
  onRefresh,
  onHelp,
}: {
  themeMode: Settings['themeMode'];
  onThemeChange: (themeMode: Settings['themeMode']) => void;
  manual: boolean;
  onManualChange: (open: boolean) => void;
  paired: boolean;
  connected: boolean;
  desktopName: string;
  lastSeen: number | null;
  deviceName: string;
  onDeviceName: (name: string) => void;
  setup: string;
  onSetup: (setup: string) => void;
  error: string;
  onScan: () => void;
  onConnect: () => void;
  onForget: () => void;
  onRefresh: () => void;
  onHelp: () => void;
}) {
  const { colors: c } = useContext(Theme);
  return (
    <>
      <ThemePicker value={themeMode} onChange={onThemeChange} />
      <Card title="连接电脑">
        <Text style={[s.h2, { color: c.ink }]}>
          {paired ? desktopName : '尚未配对电脑'}
        </Text>
        <Text style={[s.body, { color: c.muted }]}>
          {connected
            ? '已连接'
            : paired
            ? '已配对，等待连接'
            : '扫描电脑上的短期二维码'}
          {lastSeen
            ? ' · 最后更新 ' + new Date(lastSeen).toLocaleTimeString()
            : ''}
        </Text>
        {!connected && (
          <Text style={[s.body, { color: c.muted }]}>
            同一局域网 · 电脑生成二维码 · 手机确认配对
          </Text>
        )}
        <Button label="扫码连接电脑" primary={!connected} onPress={onScan} />
        <Button
          label={manual ? '收起手动配对' : '手动配对'}
          onPress={() => onManualChange(!manual)}
        />
        {manual && (
          <>
            <Input
              label="配对信息"
              value={setup}
              onChange={onSetup}
              multiline
              maxLength={4096}
            />
            <Button label="连接电脑" primary onPress={onConnect} />
          </>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={[s.body, { color: c.danger }]}>
            {error}
          </Text>
        )}
        {paired && <Button label="解除本机配对" onPress={onForget} />}
        <HelpLink label="连接帮助" onPress={onHelp} />
      </Card>
      <Card title="设备身份">
        <Input
          label="手机设备名称"
          value={deviceName}
          onChange={onDeviceName}
          maxLength={80}
        />
      </Card>
      <Card title="连接诊断">
        <Text style={[s.body, { color: c.muted }]}>
          拷贝在电脑执行 · 断线不中断已有任务
        </Text>
        <Button label="检查电脑连接" onPress={onRefresh} />
      </Card>
    </>
  );
}
