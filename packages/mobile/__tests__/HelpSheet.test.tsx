import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HelpSheet } from '../src/components/HelpSheet';
let tree: renderer.ReactTestRenderer;
const closed = jest.fn();
async function render(first = true) {
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 360, height: 800 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <HelpSheet first={first} onClose={closed} />
      </SafeAreaProvider>,
    );
  });
}
function text() {
  return tree.root
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat(5)
    .join(' ');
}
async function press(label: string) {
  await act(async () =>
    tree.root
      .findAll(t => t.props.accessibilityLabel === label && t.props.onPress)[0]!
      .props.onPress(),
  );
}
beforeEach(() => closed.mockClear());
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
test('onboarding shows three concise steps and completes without opening a task', async () => {
  await render();
  expect(text()).toContain('1 / 3');
  expect(text()).not.toContain('步骤 1');
  await press('下一步');
  expect(text()).toContain('2 / 3');
  await press('下一步');
  expect(text()).toContain('3 / 3');
  await press('开始使用');
  expect(closed).toHaveBeenCalledTimes(1);
});
test('onboarding can be skipped immediately', async () => {
  await render();
  await press('跳过引导');
  expect(closed).toHaveBeenCalledTimes(1);
});
test('offline directory opens only the chosen chapter and returns to the directory', async () => {
  await render(false);
  expect(text()).not.toContain('步骤 1');
  await press('教程 扫码连接电脑');
  expect(text()).toContain('手机和电脑连接同一局域网');
  expect(text()).not.toContain('系统后台时限');
  await press('返回教程目录');
  expect(text()).not.toContain('步骤 1');
  expect(text()).toContain('母项目与拍摄人员');
});
