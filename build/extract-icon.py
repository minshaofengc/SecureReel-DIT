#!/usr/bin/env python3
"""
把绿幕底的图标抠成透明 PNG（1024×1024）。

用途：SecureReel DIT v2.0.4 换应用图标。素材是AI 生成的绿幕图
（绿底 + 米白圆角方块 + 深色硬盘），macOS 图标必须是透明底。

## 绿幕抠图真正要做的事（踩了三轮才想明白）

绿光会**溢色**到主体边缘：方块的抗锯齿边界上，像素是"半绿 + 半主体"，
若只把绿变成透明，边界就剩一圈半透明的绿 —— 缩到 32px 看就是绿毛边。
所以单纯"按绿度算 alpha"一定留绿边。

**正确顺序是：先在 RGB 里把绿去掉，再拿一张干净的 alpha 图去遮罩。**

1. `despill()` —— 对**每一个**像素把G 压回 R/B 均值。
   不看绿度、不看 alpha，全图统一做。绿幕区压成灰白，
   主体区本来没有绿所以原样不动 —— 这一步是无损的。
2. `alpha_from_green()` —— 在**去绿后的图**上按绿度残量算 alpha。
   因为绿已经被压掉了，这一步判断的"绿度"只剩纯绿幕，
   阈值可以卡得很陡，不会误伤主体。
3. alpha 通道单独羽化（只模糊 A，不动 RGB）。

第2 步为什么能在去绿之后还算得出绿度？
去绿函数只压 G 到`min(原G, (R+B)/2)`，**绿幕像素（4,237,5）压完变成 (4,4,5)**
—— R 仍然远低于 G，差值 233，一眼可辨。而主体米白（228,223,220）
压完不变，绿度为负。所以判断依据完好。

## 阈值都是实测的，别凭感觉改
- 源图绿幕 `rgb(4,237,5)`，绿度 **232**
- 主体米白方块 `rgb(228,223,220)`，绿度 **-5**
- 主体深色硬盘 `rgb(40,40,45)`，绿度约 **0**
- 溢色过渡带绿度 **30~50**

所以 alpha 的映射在 20~60 之间迅速归零即可。

## 用法
  python3 build/extract-icon.py <输入.jpg> <输出.png>
"""
import sys
from PIL import Image, ImageFilter

# alpha 映射陡化系数：绿度超过 阈值×(1+K) 就完全透明
ALPHA_STEEPNESS = 0.6
# alpha 映射起点：绿度超过这个值才开始变透明
ALPHA_FLOOR = 14
# 边缘羽化半径（像素）
FEATHER = 1


# 判定"这是绿幕而不是青色"的第二道闸门。
#
# 实测数据（源图 rgb）：
#   绿幕        (4, 237,  5) → G - B = +232
#   青色指示灯  (62, 186, 222) → G - B = -36
#   品红指示灯  → G - B 更大为正但 R > G
#
# 绿幕是**纯绿**：G 远高于 B。青色永远 G < B。
# 单看"G 比 (R+B)/2 高多少"区分不了两者（青灯实测 39~44，
# 溢色区 30~50，两者完全重叠）—— 必须加这一道。
GREEN_OVER_BLUE = 12


def is_screen(px: tuple[int, ...]) -> bool:
    """这块像素是绿幕吗（而不是被误伤的青色/品红）。"""
    r, g, b = int(px[0]), int(px[1]), int(px[2])
    if g - b <= GREEN_OVER_BLUE:
        return False
    neutral = (r + b) / 2
    return g - neutral > 0


def despill(rgb: tuple[int, ...]) -> tuple[int, int, int]:
    """
    去绿：把 G 压到不超过 (R+B)/2。**只对绿幕像素执行。**

    早期版本对全图统一压，结果把青色指示灯也压暗了 ——
    灯从亮青变成空心黑框（实测 G-(R+B)/2 = 44，与溢色区 30~50 重叠，
    只看这一个判据区分不了）。加上 is_screen() 的第二道闸门后，
    青色/品红完全不受影响。
    """
    if not is_screen(rgb):
        return int(rgb[0]), int(rgb[1]), int(rgb[2])
    r, g, b = int(rgb[0]), int(rgb[1]), int(rgb[2])
    neutral = (r + b) / 2
    if g > neutral:
        g = int(round(neutral))
    return r, g, b


def green_left(rgb: tuple[int, ...]) -> int:
    """
    这块像素**原来有多绿**（去绿之前算）。

    ## 踩过的坑
    第一版在去绿**之后**算绿度，判据是 `g - max(r, b)`。看起来顺理成章，
    实际必然失效：绿幕是 `rgb(4, 237, 5)`，按 (R+B)/2 压完变成 `rgb(4, 4, 5)`，
    于是 `g - max(r,b) = 4 - 5 = -1` —— 判定"不是绿"，alpha 直接给满 255。
    结果整张图四角实心、背景全黑（一屏看着像"抠好了"，实际全是透明的错版）。

    正确判据是**用去绿前后的色差**：绿幕区 G 被压掉了 200 多，
    主体区几乎没被压（本来就 G≤R+B）。差值就是绿度的真实量。
    """
    if not is_screen(rgb):
        return 0
    r, g, b = int(rgb[0]), int(rgb[1]), int(rgb[2])
    neutral = (r + b) / 2
    return int(round(g - neutral))


def alpha_from_green(green: int) -> int:
    """按残余绿度算不透明度：0=全透明，255=完全不透明。"""
    if green <= ALPHA_FLOOR:
        return 255
    t = min(1.0, (green - ALPHA_FLOOR) / (ALPHA_FLOOR * ALPHA_STEEPNESS))
    return int(round(255 * (1.0 - t)))


def main() -> int:
    if len(sys.argv) != 3:
        print("用法：extract-icon.py <输入.jpg> <输出.png>", file=sys.stderr)
        return 1

    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert("RGB")
    print(f"输入 {im.size[0]}×{im.size[1]}")

    raw = list(im.getdata())

    # ---- 阶段 1：全图去绿（无损于主体）----
    despilled = [despill(px) for px in raw]

    # ---- 阶段 2：按"去绿前的绿度"算 alpha ----
    # ⚠️ 判据必须来自去绿**之前**的像素 —— 见 green_left() 里的说明。
    alphas = [alpha_from_green(green_left(px)) for px in raw]

    out = Image.new("RGBA", im.size)
    out.putdata([(r, g, b, a) for (r, g, b), a in zip(despilled, alphas)])

    # ---- 阶段 3：只模糊 alpha 通道，RGB 保持已去绿的状态 ----
    # 不能对整个 RGBA 一起模糊：边界处 alpha 被均摊成中间值时，
    # 若 RGB 也跟着被插值，就会把已压掉的绿又"混"回来。
    alpha_ch = out.getchannel("A").filter(ImageFilter.GaussianBlur(FEATHER))
    out = Image.merge("RGBA", (*out.split()[:3], alpha_ch))

    # 目标必须正好 1024×1024 —— electron-builder 从这张图转 .icns / .ico，
    # 尺寸不对会直接报"图标至少要 512×512"。
    if out.size != (1024, 1024):
        out = out.resize((1024, 1024), Image.LANCZOS)

    out.save(dst, "PNG")

    # ---- 自检：还剩多少"不透明且偏绿"的像素 ----
    px = out.load()
    w, h = out.size
    residue = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b, a = px[x, y]
            if a > 90 and (g - max(r, b)) > 12:
                residue += 1
    total = (w // 2) * (h // 2)
    print(f"已写出 {dst}（{w}×{h}，透明底）")
    verdict = "✓ 干净" if residue < 20 else "✗ 仍有绿边"
    print(f"自检：残留偏绿像素 {residue} / {total}（步长2采样）{verdict}")
    return 0 if residue < 20 else 1


if __name__ == "__main__":
    raise SystemExit(main())
