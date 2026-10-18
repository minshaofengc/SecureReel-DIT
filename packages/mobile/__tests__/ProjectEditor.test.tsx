import React, { useEffect, useState } from 'react';
import renderer, { act } from 'react-test-renderer';
import { TextInput, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ProjectEditor } from '../src/components/ProjectEditor';
import { emptyDetails, type ProjectDetails } from '../src/projectData';
let tree: renderer.ReactTestRenderer;
let latest: ProjectDetails;
function Harness({ initial }: { initial: ProjectDetails }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    latest = value;
  }, [value]);
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 360, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <ProjectEditor value={value} onChange={setValue} />
    </SafeAreaProvider>
  );
}
function press(label: string) {
  return act(async () =>
    tree.root
      .findAll(t => t.props.accessibilityLabel === label && t.props.onPress)[0]!
      .props.onPress(),
  );
}
function input(label: string) {
  return tree.root
    .findAllByType(TextInput)
    .find(t => t.props.accessibilityLabel === label)!;
}
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
test('fifty crew members stay compact and a searched member can be edited without changing others', async () => {
  const initial = {
    ...emptyDetails(),
    crew: Array.from({ length: 50 }, (_, i) => ({
      name: `人员${i}`,
      role: 'DIT',
    })),
  };
  await act(async () => {
    tree = renderer.create(<Harness initial={initial} />);
  });
  expect(tree.root.findAllByType(TextInput)).toHaveLength(4);
  await press('管理人员');
  await act(async () => input('搜索姓名或职位').props.onChangeText('人员49'));
  await press('编辑人员 人员49');
  await act(async () => {
    input('人员姓名').props.onChangeText('修改姓名');
    input('人员职位').props.onChangeText('摄影指导');
  });
  await press('保存人员');
  expect(latest.crew[49]).toEqual({ name: '修改姓名', role: '摄影指导' });
  expect(latest.crew.slice(0, 49)).toEqual(initial.crew.slice(0, 49));
});
test('cancelled person is not added and a removed person can be restored', async () => {
  await act(async () => {
    tree = renderer.create(
      <Harness
        initial={{ ...emptyDetails(), crew: [{ name: '张三', role: 'DIT' }] }}
      />,
    );
  });
  await press('管理人员');
  await press('添加人员');
  await act(async () => input('人员姓名').props.onChangeText('不保存'));
  await press('取消人员编辑');
  expect(latest.crew).toHaveLength(1);
  await press('编辑人员 张三');
  await press('移除人员');
  expect(latest.crew).toHaveLength(0);
  await press('撤销移除');
  expect(latest.crew).toEqual([{ name: '张三', role: 'DIT' }]);
});
test('forty lenses stay compact and cannot exceed the existing limit', async () => {
  await act(async () => {
    tree = renderer.create(
      <Harness
        initial={{
          ...emptyDetails(),
          lenses: Array.from({ length: 40 }, (_, i) => ({
            model: `镜头${i}`,
            detail: '50mm',
          })),
        }}
      />,
    );
  });
  expect(tree.root.findAllByType(TextInput)).toHaveLength(4);
  await press('管理镜头');
  await act(async () => input('搜索型号或编号').props.onChangeText('镜头39'));
  const add = tree.root.findAll(
    t => t.props.accessibilityLabel === '添加镜头' && t.props.onPress,
  )[0]!;
  expect(add.props.disabled).toBe(true);
  await press('编辑镜头 镜头39');
  await act(async () => input('镜头型号').props.onChangeText('新镜头'));
  await press('保存镜头');
  expect(latest.lenses[39].model).toBe('新镜头');
  expect(latest.lenses).toHaveLength(40);
  expect(tree.root.findAllByType(Text).length).toBeGreaterThan(0);
});

test.each([0, 1, 20])(
  'crew count %i keeps the editor compact and adding one entry preserves existing people',
  async count => {
    const original = Array.from({ length: count }, (_, i) => ({
      name: '原人员' + i,
      role: 'DIT',
    }));
    await act(async () => {
      tree = renderer.create(
        <Harness initial={{ ...emptyDetails(), crew: original }} />,
      );
    });
    expect(tree.root.findAllByType(TextInput)).toHaveLength(4);
    await press('管理人员');
    await press('添加人员');
    await act(async () => {
      input('人员姓名').props.onChangeText('新人员');
      input('人员职位').props.onChangeText('自定义职位');
    });
    await press('保存人员');
    expect(latest.crew.slice(0, count)).toEqual(original);
    expect(latest.crew[count]).toEqual({ name: '新人员', role: '自定义职位' });
  },
);
