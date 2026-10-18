// SPDX-License-Identifier: GPL-3.0-only
import React, { useContext, useRef, useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import { Button, Card, Input, ModalPage, Theme, s } from './ui';
import type { ProjectDetails } from '../projectData';
type Kind = 'crew' | 'lenses';
type Entry = { name: string; role: string } | { model: string; detail: string };
export type RemovalRecord = { kind: Kind; index: number; entry: Entry };
export function ProjectEditor({
  value,
  onChange,
  removalHistory,
  onRemovalHistoryChange,
}: {
  value: ProjectDetails;
  onChange: (value: ProjectDetails) => void;
  removalHistory?: RemovalRecord[];
  onRemovalHistoryChange?: (history: RemovalRecord[]) => void;
}) {
  const { colors: c } = useContext(Theme);
  const [manager, setManager] = useState<Kind | null>(null),
    [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    index: number;
    entry: Entry;
    original: string;
  } | null>(null);
  const [internalHistory, setInternalHistory] = useState<RemovalRecord[]>([]);
  const history = removalHistory ?? internalHistory,
    setHistory = onRemovalHistoryChange ?? setInternalHistory;
  const removed = history.filter(item => item.kind === manager).at(-1);
  const [error, setError] = useState('');
  const keys = useRef(new WeakMap<object, string>()),
    counter = useRef(0);
  const keyFor = (entry: object) => {
    let key = keys.current.get(entry);
    if (!key) {
      key = `item-${++counter.current}`;
      keys.current.set(entry, key);
    }
    return key;
  };
  const update = (kind: Kind, entries: Entry[]) =>
    onChange(
      kind === 'crew'
        ? { ...value, crew: entries as ProjectDetails['crew'] }
        : { ...value, lenses: entries as ProjectDetails['lenses'] },
    );
  const begin = (index: number, entry: Entry) => {
    setError('');
    setEditing({ index, entry: { ...entry }, original: JSON.stringify(entry) });
  };
  const closeEditor = () => {
    if (editing && JSON.stringify(editing.entry) !== editing.original)
      Alert.alert('放弃未保存的修改？', '本次填写尚未加入母项目。', [
        { text: '继续编辑', style: 'cancel' },
        {
          text: '放弃修改',
          style: 'destructive',
          onPress: () => setEditing(null),
        },
      ]);
    else setEditing(null);
  };
  const saveEntry = () => {
    if (!manager || !editing) return;
    const entries: Entry[] = [...value[manager]];
    if (editing.index < 0 && entries.length >= (manager === 'crew' ? 50 : 40))
      return;
    const entry = Object.fromEntries(
      Object.entries(editing.entry).map(([k, v]) => [k, v.trim()]),
    ) as Entry;
    if (
      Object.values(entry).some(v =>
        [...v].some(ch => (ch.codePointAt(0) ?? 0) < 32),
      )
    ) {
      setError('请移除不可见控制字符。');
      return;
    }
    if (editing.index < 0) entries.push(entry);
    else entries[editing.index] = entry;
    update(manager, entries);
    setEditing(null);
    setError('');
  };
  const field = (
    key: 'projectName' | 'shootDay' | 'camera' | 'notes',
    label: string,
  ) => (
    <Input
      label={label}
      value={value[key]}
      onChange={v => onChange({ ...value, [key]: v })}
      maxLength={key === 'notes' ? 4000 : key === 'shootDay' ? 40 : 120}
      multiline={key === 'notes'}
    />
  );
  const summary = (kind: Kind, title: string) => (
    <Card
      title={`${title} · ${value[kind].length}${kind === 'crew' ? ' 位' : ' 颗'}`}
    >
      {value[kind].length === 0 ? (
        <Text style={[s.body, { color: c.muted }]}>尚未添加{title}</Text>
      ) : (
        value[kind].slice(0, 3).map((entry, i) => (
          <Text key={i} numberOfLines={2} style={[s.body, { color: c.ink }]}>
            {'name' in entry
              ? `${entry.name || '未填写姓名'} · ${entry.role || '未填写职位'}`
              : `${entry.model || '未填写型号'} · ${entry.detail || '未填写编号'}`}
          </Text>
        ))
      )}
      {value[kind].length > 3 && (
        <Text style={[s.body, { color: c.muted }]}>
          另有 {value[kind].length - 3} 项资料
        </Text>
      )}
      <Button
        label={kind === 'crew' ? '管理人员' : '管理镜头'}
        onPress={() => {
          setManager(kind);
          setSearch('');
          setEditing(null);
        }}
      />
    </Card>
  );
  const entries = manager
    ? value[manager]
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) =>
          Object.values(entry)
            .join(' ')
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
        )
    : [];
  return (
    <View style={{ gap: 16 }}>
      {field('projectName', '项目名称')}
      {field('shootDay', '拍摄日期')}
      {field('camera', '摄影机')}
      {summary('crew', '拍摄人员与职位')}
      {summary('lenses', '镜头资料')}
      {field('notes', '项目备注')}
      {manager && (
        <ModalPage
          title={
            editing
              ? manager === 'crew'
                ? '编辑人员'
                : '编辑镜头'
              : manager === 'crew'
                ? '人员管理'
                : '镜头管理'
          }
          onClose={() => (editing ? closeEditor() : setManager(null))}
          scroll={Boolean(editing)}
        >
          {editing ? (
            <>
              {'name' in editing.entry ? (
                <>
                  <Input
                    label="人员姓名"
                    value={editing.entry.name}
                    maxLength={80}
                    onChange={name =>
                      setEditing(prev =>
                        prev
                          ? { ...prev, entry: { ...prev.entry, name } }
                          : null,
                      )
                    }
                  />
                  <Input
                    label="人员职位"
                    value={editing.entry.role}
                    maxLength={80}
                    onChange={role =>
                      setEditing(prev =>
                        prev
                          ? { ...prev, entry: { ...prev.entry, role } }
                          : null,
                      )
                    }
                  />
                  <Text style={[s.body, { color: c.muted }]}>
                    常用职位，也可以直接填写
                  </Text>
                  <View style={s.row}>
                    {[
                      '导演',
                      '摄影指导',
                      '摄影助理',
                      'DIT',
                      '数据管理员',
                      '制片',
                    ].map(role => (
                      <Button
                        key={role}
                        label={role}
                        onPress={() =>
                          setEditing(prev =>
                            prev
                              ? { ...prev, entry: { ...prev.entry, role } }
                              : null,
                          )
                        }
                      />
                    ))}
                  </View>
                </>
              ) : (
                <>
                  <Input
                    label="镜头型号"
                    value={editing.entry.model}
                    maxLength={120}
                    onChange={model =>
                      setEditing(prev =>
                        prev
                          ? { ...prev, entry: { ...prev.entry, model } }
                          : null,
                      )
                    }
                  />
                  <Input
                    label="焦段或编号"
                    value={editing.entry.detail}
                    maxLength={120}
                    onChange={detail =>
                      setEditing(prev =>
                        prev
                          ? { ...prev, entry: { ...prev.entry, detail } }
                          : null,
                      )
                    }
                  />
                </>
              )}
              {!!error && (
                <Text accessibilityRole="alert" style={{ color: c.danger }}>
                  {error}
                </Text>
              )}
              <Button
                label={manager === 'crew' ? '保存人员' : '保存镜头'}
                primary
                onPress={saveEntry}
              />
              <Button
                label={manager === 'crew' ? '取消人员编辑' : '取消镜头编辑'}
                onPress={() => setEditing(null)}
              />
              {editing.index >= 0 && (
                <Button
                  label={manager === 'crew' ? '移除人员' : '移除镜头'}
                  onPress={() => {
                    setHistory([
                      ...history,
                      {
                        kind: manager,
                        index: editing.index,
                        entry: value[manager][editing.index],
                      },
                    ]);
                    update(
                      manager,
                      value[manager].filter((_, i) => i !== editing.index),
                    );
                    setEditing(null);
                  }}
                />
              )}
            </>
          ) : (
            <>
              <Input
                label={manager === 'crew' ? '搜索姓名或职位' : '搜索型号或编号'}
                value={search}
                onChange={setSearch}
                maxLength={120}
              />
              <Button
                label={manager === 'crew' ? '添加人员' : '添加镜头'}
                primary
                disabled={
                  value[manager].length >= (manager === 'crew' ? 50 : 40)
                }
                onPress={() =>
                  begin(
                    -1,
                    manager === 'crew'
                      ? { name: '', role: '' }
                      : { model: '', detail: '' },
                  )
                }
              />
              {removed?.kind === manager && (
                <View style={{ gap: 8 }}>
                  <Text style={[s.body, { color: c.muted }]}>
                    已移除，母项目保存前可以撤销。
                  </Text>
                  <Button
                    label="撤销移除"
                    disabled={
                      value[manager].length >= (manager === 'crew' ? 50 : 40)
                    }
                    onPress={() => {
                      const next: Entry[] = [...value[manager]];
                      next.splice(
                        Math.min(removed.index, next.length),
                        0,
                        removed.entry,
                      );
                      update(manager, next);
                      setHistory(history.filter(item => item !== removed));
                    }}
                  />
                </View>
              )}
              <FlatList
                data={entries}
                keyExtractor={item => keyFor(item.entry)}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={12}
                ListEmptyComponent={
                  <Text style={[s.body, { color: c.muted }]}>
                    {search ? '没有匹配的资料' : '点击上方按钮添加资料'}
                  </Text>
                }
                renderItem={({ item }) => (
                  <View
                    style={{
                      paddingVertical: 8,
                      flexDirection: 'row',
                      alignItems: 'center',
                      borderBottomWidth: 1,
                      borderColor: c.line,
                      gap: 12,
                    }}
                  >
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text
                        style={[s.h2, { color: c.ink, fontSize: 16 }]}
                        numberOfLines={2}
                      >
                        {'name' in item.entry
                          ? item.entry.name || '未填写姓名'
                          : item.entry.model || '未填写型号'}
                      </Text>
                      <Text
                        style={[s.body, { color: c.muted }]}
                        numberOfLines={2}
                      >
                        {'role' in item.entry
                          ? item.entry.role || '未填写职位'
                          : item.entry.detail || '未填写编号'}
                      </Text>
                    </View>
                    <Button
                      label="编辑"
                      accessibilityLabel={
                        (manager === 'crew' ? '编辑人员 ' : '编辑镜头 ') +
                        ('name' in item.entry
                          ? item.entry.name
                          : item.entry.model)
                      }
                      onPress={() => begin(item.index, item.entry)}
                    />
                  </View>
                )}
              />
            </>
          )}
        </ModalPage>
      )}
    </View>
  );
}
