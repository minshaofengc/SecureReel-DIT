# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)；版本号遵循语义化版本。

## [2.0.6] - 2026-10-11

### Added

- Per-job editing proxies: ProRes 422 Proxy/LT/422/HQ, H.264/H.265, 1080p/1440p/4K output and optional 3D LUT. Local encoder detection determines availability; proxies stay under `Proxies/` and never replace verified original backups.
- Proxy outcomes and skip reasons in reports, with expanded media metadata extraction.

### Changed

- Three palettes (neutral, graphite blue, warm sand), retaining card/compact/focus view modes; task configuration and monitoring refinements.
- Removed the previous splash animation; the app opens directly into the workbench.
- Published macOS Universal DMG/ZIP and Windows x64 Setup/Portable/ZIP with SHA-256 checksums.

### Validation and limitations

- Type checks, lint, 608 unit tests, 56 Electron pipeline checks and application startup smoke checks passed. ASC MHL output was checked with the official XSD using lxml.
- Packaged macOS and Windows main programs match the current 2.0.6 production build. Windows remains a public beta with limited real-hardware validation; builds are unsigned/unnotarised.
- Proprietary RAW decoding and official HDE workflows depend on format, installed vendor tools and hardware validation.

## [2.0.5] - 2026-10-10

> Theme / 本版主题: **back to open source — and an interface rebuilt around
> "what should I do now".**
> **重新开源，以及一次终于围绕"我现在该干什么"重做的界面。**

### Changed / 变更

- **The app is GPL-3.0-only again.** 2.0.4 shipped as a commercially licensed,
  time-limited build. 2.0.5 returns the project to free and open source under the
  same licence as 2.0.3, and removes the 60-day trial and the entire offline
  licence-key subsystem (machine binding, activation, registration, purchase
  request) — no trial, no activation, no nag. 2.0.3 and earlier remain GPL-3.0;
  2.0.4 was the only commercially licensed release.

- **重新开源：本版恢复 GPL-3.0-only。** 2.0.4 曾是商业许可的限时版本；2.0.5 把项目
  恢复到与 2.0.3 相同的免费开源许可，并**全部移除** 60 天试用与整套离线授权子系统
  （机器绑定、激活、登记、购买申请）——没有试用期、没有激活码、没有提醒。
  2.0.3 及更早仍是 GPL-3.0；2.0.4 是唯一一个商业许可版本。

### Added / 新增

- **A rebuilt interface.** A new workbench home page answers "what should I do now"
  (the running job if there is one, otherwise "pick a source") instead of always
  landing on the offload page. Navigation is now three stages — create → monitor →
  deliver — replacing the 01–07 numbering, which implied an order that did not
  exist. Settings and Help moved to the top-right.

- **界面重做。** 新增「工作台」首页回答"我现在该干什么"（有任务在跑就显示那个任务，
  否则显示"选来源"），不再一律落在拷贝页。导航改为三段——产出 → 监控 → 交付——
  取代了暗示不存在顺序的 01–07 编号；设置与帮助移到右上角。

- **Three view modes** (cards / compact / focus), switched from a dock in the
  bottom-right corner. They change layout only, never data.

- **三种视图模式**（卡片式 / 紧凑式 / 专注式），从右下角停靠区切换。只改版式，不动数据。

- **Appearance settings: light / dark and five colour schemes** (Darkroom, Steel,
  Mono, Sand, Indigo). Contrast is guarded by a test that reads the real tokens.

- **外观设置：明暗两档与五套配色**（暗房 / 石墨蓝 / 中性 / 暖砂 / 靛青）。
  对比度由一条直接读真实 tokens 的测试守着。

### Removed / 移除

- The trial period, the offline licence-key system, the first-run activation
  wizard, the licence card and the expiry banner.

- 试用期、离线授权系统、首启激活向导、许可证卡片与到期横幅。

## [2.0.3] - 2026-10-04

> Theme / 本版主题: **a splash screen, seven checksum algorithms, four manifest formats,
> two clearly different blues — and a progress bar that finally tells the truth.**
> **开屏动画、七种校验算法、四种清单格式、两套真正分得开的蓝，以及一条终于说真话的进度条。**

### Added / 新增

- **A start-up screen: film perforations rolling, timecode running.** The main window
  cannot paint until a whole chain has finished (1.x data migration, opening SQLite,
  creating log directories, assembling services). That gap is several seconds on a real
  set machine, and a blank screen is what makes people click the icon a second time.
  The splash appears the instant the app is ready and reports the **actual** steps it is
  on. It stays for at least 1.5 s so it never just flickers, and it waits for the main
  window to be visible before fading out — otherwise the desktop flashes in between.

- **新增开屏动画：胶片齿孔走动、时码跳动。** 主窗口要等一长串事情做完才能画
  （1.x 数据迁移、打开 SQLite、建日志目录、装配服务），现场机器上这段有好几秒——
  而黑屏正是让人"再点一次图标"的原因。开屏在应用就绪的瞬间出现，
  并且显示**真实**进行到哪一步。最短停留 1.5 秒，不会一闪而过；
  淡出前会先等主窗口显示出来，否则中间会闪一下桌面。

- **Six more checksum algorithms** — xxHash3, xxHash128 (same speed family as the
  default xxHash64, newer), SHA-1, SHA-256 (portable, universally recognised) —
  alongside the existing xxHash64, MD5 and ASC C4.

- **新增六种校验算法**：xxHash3、xxHash128（与默认的 xxHash64 同一条速度路线，
  版本更新）、SHA-1、SHA-256（对外通用、谁都能核），加上原有的 xxHash64、MD5、ASC C4。

- **Two more manifest formats: CSV and JSON.** CSV is a plain table — byte-order mark
  included, so Windows Excel renders Chinese clip paths correctly — and it is the
  fastest thing to hand to another department. Cell values are quoted per RFC 4180 and
  values starting with `=` `+` `-` `@` are prefixed, because a filename on a camera card
  is external input and Excel will happily execute `=cmd|...` as a formula.

- **新增两种清单格式：CSV 与 JSON。** CSV 就是一张表——带 BOM，这样 Windows 版
  Excel 才能正确显示中文素材路径——是丢给别的部门最快的东西。单元格按 RFC 4180
  转义，以 `=` `+` `-` `@` 开头的值会加前缀：相机卡上的文件名是外部输入，
  而 Excel 真的会把 `=cmd|...` 当公式执行。

- **Developer and acknowledgement credits** on the help page, and on the splash screen.

- **帮助页与开屏动画上加上开发者与鸣谢署名。**

### Changed / 变更

- **Progress now counts verification as work.** Every file was already read once, written
  to every target, and then **read back from every target** to compare. The bar only ever
  counted the first of those three, so at the tail of a job — copy finished, verification
  still draining — it sat just under 100% and did not move, which looks exactly like a
  hang. Total work is now `bytes × (1 + targets to verify)` and the percentage is
  computed once, in the main process.

- **进度条现在把校验也算作工作量。** 每个文件本来就要读一遍、写进每个目标、
  再从每个目标**完整重读一遍**比对。老口径只算了第一件，于是收尾阶段
  （拷贝读完、校验还在排队）会停在接近 100% 一动不动，看起来跟卡死一样。
  现在总工作量是「字节 × (1 + 要校验的目标数)」，百分比由主进程算一次。

- **The progress bar is a solid colour, not a gradient.** Pink Blue's blue-to-pink sweep
  spanned 137° of hue and rendered as a coloured stripe — busy to look at, and easy to
  misread as meaning something. Same lesson as the primary button two releases ago.

- **进度条改成纯色，不再用渐变。** 雾光的蓝→粉色相横跨 137°，渲染成一条彩色斜纹，
  既晃眼又容易被误读成有别的含义——和两个版本前主按钮那次是同一个教训。

- **“Pink Blue” and “Blue Violet” were too close to tell apart.** Blue Violet's primary
  was an indigo only 30° from Pink Blue's. Pink Blue is now a genuine **sky blue**
  (hue 203°) with its warm pink, and Blue Violet is now **violet** (hue 265°). 62° apart,
  and their backgrounds and overall temperature differ too.

- **粉蓝「雾光」和蓝紫「鸢尾」原本分不出来。** 鸢尾的主色是靛蓝，和雾光只差 30°。
  现在雾光是真正的**天青蓝**（色相 203°）配暖粉，鸢尾是**紫罗兰**（色相 265°），
  主色相差 62°，底色与整体冷暖也一起拉开了。

- **The copy page no longer shows a fake 40% bar** while scanning the source. Scanning a
  full card takes minutes and that duration is genuinely unknown, so it is now an
  indeterminate bar with a plain sentence — "still working", not a number pretending to
  be a measurement.

- **拷贝页扫源盘时不再显示写死的 40%。** 扫一张满卡要几分钟，时长本来就未知，
  所以改成不定态进度条 + 一句说明：只表达"还在动"，不假装那个数字是测出来的。

### Fixed / 修复

- **CSV and JSON manifests were rejected for `SHA-256` + `ASC MHL` before you could
  create a bad job**: the settings page greys out impossible combinations and states the
  reason, and the writer refuses independently — a greyed-out option cannot stop a value
  that came from an older database or straight over IPC.

- **在生成出坏清单之前就挡住了 `SHA-256` + `ASC MHL` 这种组合**：设置页把不成立的
  组合标灰并写明原因，写入器也会独立拒绝——灰选项挡不住旧数据库里的值，
  也挡不住直接通过 IPC 传进来的参数。

### Notes / 说明

- The splash screen's few inline colours are a **deliberate exception** to the
  "every colour comes from tokens.css" rule: that window exists before the theme system
  does. If you pin a non-default theme, the splash's accent may briefly differ.

- 开屏窗里那几个内联色值是"所有颜色都走 tokens.css"这条规矩的**刻意例外**：
  那个窗口出现在主题系统就绪之前。如果把主题钉成非默认配色，
  开屏那一两秒的主色可能与界面不一致。

- macOS build is 2.0.3; the Windows build stays at 2.0.2 (public Beta, still pending
  real-machine verification) and will catch up with the next Windows build.
  macOS 版为 2.0.3；Windows 版仍是 2.0.2（公开测试版，尚待真机验证），
  会随下一次 Windows 打包跟上。

## [2.0.2] - 2026-10-03

> Theme / 本版主题: **the shoot day always equals this computer's current date.**
> **拍摄日永远等于这台电脑今天的日期。**

### Fixed / 修复

- **Crossing midnight with the app open now rolls the "shoot day" over to the new day.**
  The date used to be filled in only **at the moment you entered the copy page**. A very
  common pattern on set is to leave the app open in the evening and keep offloading
  through the night or the next morning — the field would still hold the previous day,
  nobody would think to change it, and a whole batch of cards would silently be dated
  one day off. The format stays perfectly valid and no error is raised.

  It now catches up at three moments: returning to the copy page, the window regaining
  focus, and once a minute (an offload is a long run; nobody touches the window).

- **But it only rewrites a value the app itself filled in.** If that field was edited by
  hand, not a character is touched — someone re-checking yesterday's cards deliberately
  enters an older date, and that must never be overwritten just because midnight passed.

- **开着软件跨过午夜时，「拍摄日」会自己跟上新的一天。**

  日期原本只在**进拷贝页那一刻**填好。现场很常见的是"晚上把软件打开放那儿、
  凌晨或第二天接着拷" —— 那时框里还停在前一天，没人会想到去改它，
  于是整批卡的拍摄日默默错一天，而且格式完全合法、不报任何错。

  现在会在三个时点自动跟上：切回拷贝页、窗口重新获得焦点、以及每分钟一次
  （拷贝是长跑，中途没人会去点窗口）。

- **但只改"程序填的值"。** 如果那个框被人手动改过，一个字都不动 ——
  补拷昨天卡的人会故意填昨天的日期，那种值绝不能因为过了半夜被悄悄改掉。

### Notes / 说明

- This finishes what 2.0.1 started: that release guaranteed the date was correct
  **when you opened the page**; this one guarantees it stays correct.
  这条是上一版"拍摄日默认当天"的收尾：上一版保证**进页面那一刻**是当天，
  这一版保证**一直**是当天。

## [2.0.1] - 2026-10-01

> 本版主题：**母项目真的记住东西了**，外加拍摄日不再默默错一天。

### 新增

- **母项目记住职员与镜头。** 在拷贝页填的职员（导演、摄影指导……）与镜头，
  在创建任务时会自动记进所属母项目；下次再选这个母项目，直接带出来。

- **回捞：把旧版本漏存的内容还给你。** 在此之前，拷贝页填的内容只写进
  那一次任务的快照，从不写回母项目档案。于是会出现一种很像"数据丢了"的现象 ——
  母项目卡片看着是空的，可它名下的任务里明明存着十几个职员。
  现在选中母项目时会从它名下历史任务的快照里把空着的字段补回来，
  补到的是**只读的显示值**：档案本身要等你真的动手编辑才会被改写。

### 修复

- **拍摄日默认填当天，且不再沿用上一次。** 原来进入拷贝页会带上一次填的日期，
  隔天再拷就必然错一天；而且 `2026-9-30` 这种格式完全合法，不报任何错，
  一路错进报告和清单。

  同时修掉一个更隐蔽的：原先取"今天"用的是 UTC 日期
  （`toISOString().slice(0, 10)`）。东八区凌晨 0 点到 8 点之间 UTC 还停在前一天，
  于是**通宵拍完凌晨拷卡时，"今天"会变成"昨天"** —— 而这恰恰是剧组最常拷卡的时段。
  现在按本机时区取整。

- **母项目页不再显示「拍摄日」。** 它属于"这一次拷贝拍的是哪天"，
  不属于整部戏不变的属性；拷贝页每次都会重置成当天，从不读母项目的值。
  留一个填了却不起作用的字段，比不显示更让人困惑。

### 界面上说清楚的话

- 拷贝页原来写着「下面改动只影响这一次拷贝，不会改到母项目」。
  现在职员与镜头会写回母项目，这句话不再成立，已改成如实的说明。

### 数据安全

- 回捞只补空、写回只动镜头与人员；**本次没填就什么都不写**，
  绝不用空数组把攒了很久的名单清掉。机型、项目名、备注、拍摄日一概不碰。
- 本版**没有改动数据库结构**，存量任务、母项目与已生成的报告原样保留。

## [1.2.5] - 2026-09-18

> 本版主题：**报告重新变得可信**，附带的路径与双语问题一起收掉。
>
> 这一版修的不是崩溃，而是"代码里写了、界面上承诺了、实际不生效"的那一类。
> 其中三条会让人**看着报告做出错误判断**。

### 修复

- **报告的「执行说明」一节原来是空的。** 严重程度：报告是交付物，这一节没了，
  拿到报告的人看不到"这份报告是什么"。

  根因是时序：报告先渲染再落盘，而调用方拿到返回值里的附注数组后才往里塞说明 ——
  塞进去的四条（未正常结束 / 仅校验模式 / PDF 缺图 / 内联跳过）**全部被丢弃**。

  现在附注必须在**渲染之前**交进去，于是「执行说明」真的会写出来：

  | 场景 | 报告里现在会写着 |
  |---|---|
  | 仅校验任务 | 本任务为「仅校验」模式：只读取并比对两侧的校验值，未向目标盘写入或删除任何数据 |
  | 被取消 / 失败的任务 | 本次任务未正常结束（状态：…），因此没有把清单写入目标盘 |
  | 归档了首帧图 | 已归档 N 张首尾帧缩略图（frames/ 目录） |

  **这一条最要紧的是"仅校验"那句** —— 在此之前，一份仅校验（复核）报告和一份
  拷贝交付报告长得一模一样，收到 PDF 的人无从分辨。

  依赖渲染结果的另外两条（PDF 缺图数、超出内联预算张数）改为**界面提示 + 日志**：
  往报告里补写就得重渲染 HTML 并把 `report.json` 的逐文件记录整体再流一遍，
  十万条素材的任务为此多跑一遍全量查询，不划算。信息没丢，只是不落在交付物里。

- **报告里的目标失败数与任务失败数会自相矛盾。** 目标级计数原来分散在十几个失败
  分支里各记一次，漏掉了整整一类：**仅校验时"目标上文件不存在 / 尺寸不符 / 读不动"**。
  现象是报告的目标表显示该目标失败 `0`，而任务级 `failedFiles` 不是 0。

  现在改成**文件结清时按最终结果统一记一次**（拷贝引擎里 `countTargetResult()`），
  并在测试里钉住"只记一次"——既不能漏，也不能因为迁移计数点而翻倍。

- **源路径带尾斜杠会让每个文件都拷不过去。** 从访达「拷贝路径」或终端粘贴
  `/Volumes/CARD/` 很常见，而原来的相对路径是 `absPath.slice(root.length + 1)` 算的：
  尾斜杠让每条相对路径都被**吃掉第一个字符**（`DCIM/100/A001.MP4` → `CIM/100/A001.MP4`）。
  扫描阶段看不出问题（文件数、体积都对），一开跑每个文件都报"读取源文件失败"。

  现在统一先去尾斜杠，相对路径改用 `posix.relative()` 计算，并在建任务入口把
  源与目标路径规整后落库。

  顺带修掉同源的一处：**尾斜杠会让自动推导的任务名变成空串**，
  创建请求被校验拒绝，只弹一句「请填写任务名称」——而输入框本来就是空的。

- **任务运行中可以「生成报告」，会让引擎重做已经处理过的文件。** 写报告时顺带把
  `copying` / `verifying` 的行归零成 `pending`，引擎下一批就把同一批文件又捞出来：
  `filesDone` 可能超过 `totalFiles`、`bytesDone` 翻倍，两个线程抢提交同一个分片时
  还会让**健康盘被误判隔离**。

  现在：写报告不再改动任何文件状态；运行中（含排队 / 暂停）调用生成报告会被拒绝；
  界面上的「生成报告」按钮相应禁用并给出原因。

### 双语一致性

英文界面下会冒出中文的地方都收干净了。此前是"消息表里键配好了中英文，
结果代码里写死中文"：

- `job.alreadyRunning`、`engine.writeZeroBytes` 两个键**定义了却从未被引用**，
  对应位置写死中文 → 现在真有调用点了；
- **IPC 处理器层 9 处**硬编码中文（如"任务不存在。""任务正在运行，请先取消再删除。"）
  → 全部走消息表，其中"任务不存在。"不再有第二份实现；
- **渲染层**：空间不足提示整段、机型「自动识别」、HDE「官方转码器」、
  「该目标已在列表里」、目标数量上限、初始化失败提示、Help 页的「平台 / 许可」、
  默认任务名、「降级」徽章（原来显示的是「未知」）→ 全部走 i18n；
- **旧库隔离的提示**原来主进程与界面各拼半句，界面上「检测到旧版本数据库」出现两次
  → 主进程改为只返回结构化事实（备份路径），文案归渲染层，同时这条也支持英文了；
- 占位符统一成 `{name}` 一种写法（原来是 `%N%` 与 `{name}` 两套并存）。

### 内部

- 新增 `tests/job-report.test.ts`：覆盖 JobManager 与报告层的**接线** ——
  只测报告层是覆盖不到这次的缺陷的。
- 新增 `tests/messages.test.ts`：钉住占位符替换，以及"漏传参数时占位符原样保留"
  （界面上出现一个 `{count}` 很扎眼，比悄悄变成空串好）。
- 新增 `stripTrailingSeparators()` 与 `isJobLive()` 两个共享工具；
  占位符替换合并为 `fillTemplate()` 一份实现，供主进程与渲染层共用。
- 测试 358 → 382 条。

## [1.2.4] - 2026-09-18

> 本版主题：佳能机内 RAW 的**参数**能进报告了（画面仍然没有）。

### 新增

- **佳能 Cinema RAW Light（`.CRM`）的元数据探测已开启。**
  报告的「媒体元数据」表现在会给出该素材的**时长、时码、拍摄时间、分辨率、帧率**。
  用一条真实的 1 GB EOS R5 C 素材（4096×2160）实测：

  | 读出 | 值 |
  |---|---|
  | 时码 | `08:21:48:23` |
  | 时长 | 9.009 秒 |
  | 分辨率 | 4096×2160 · 23.976 fps |
  | 拍摄时间 | 2020-09-08T00:56:13Z |
  | 编码标识 | `CRAW`（画面轨 fourcc） |

  探测成本 0.01 秒/条（`moov` 在文件头部），对拷贝流程没有影响。

  **仍然没有画面**，这是格式决定的，不是配置问题：ffmpeg 没有 CRAW 解码器
  （FFmpeg trac #6765 自 2017 年 open），而且**文件里也没有内嵌预览图**
  （实测：前 96 MiB + 尾部 16 MiB 内可解析 JPEG 为 0，`moov` 里没有图片轨）。
  要画面只能用 Canon 官方工具（Cinema RAW Development / DaVinci Resolve）。

### 修复

- **识别 CRAW 不再依赖巧合。** 原来 `.CRM` 能拿到正确格式名，是因为
  ffprobe 对 CRAW **连 `codec_name` 字段都不输出**，一路落到扩展名兜底 ——
  那是巧合。现在显式认画面轨的 fourcc `CRAW`，无论 ffprobe 输出缺失还是
  写成 `none` 都能认对。

- **说明文字不再误导。** 之前 CRM 的说明里会写"本次未提取首帧（可在设置中开启
  「为视频素材提取首帧」）"—— 暗示开了开关就有画面，而实际开了也没有。
  现在这条提示只在**真的是视频类素材**时才出现；对解不出的格式改为明确写
  "该格式也没有可用的内嵌预览图，因此本报告不含该素材的画面"。

- **`codec_name` 为 `none` / `unknown` 时不再当格式名。** 那只是"认不出来"的意思，
  直接写进报告会变成「格式：none」，比留空更误导。

## [1.2.3] - 2026-09-18

> 本版主题：报告不再"静默留白" —— 拿不到首帧的素材要自己说明原因。

### 修复

- **报告在无法生成首帧时，会专门说明原因，而不是整块消失。**
  之前的报告里，「首帧画面」这一节只在有图时才渲染，
  而「媒体元数据」表也以"探测可用"为门槛 —— 像佳能 Cinema RAW Light（`.CRM`）
  这种既解不出画面、探测又不可用的素材，报告里**一个字都不会提**。
  拿到报告的人（尤其是后期）看到静帧整节缺失，会怀疑拷贝或工具出了问题。
  现在会输出一节「没有首帧画面的素材」，点名格式、说明原因、给出需要的厂商官方工具，
  并明确写出**这与拷贝和校验结果无关**（这些文件同样逐字节写入并通过独立重读校验）。

### 修正

- 上一版 CHANGELOG 写的"队列页**与报告**的格式列显示 CRM（Canon Cinema RAW Light）"
  对报告那半句不准确：1.2.2 时报告里还看不到它（报告只在"探测可用"时才输出媒体元数据表）。
  报告侧要到本版才有 —— 位置在新的「没有首帧画面的素材」一节里。

### 说明（实测结论，供选型参考）

用一条真实的 1 GB `.CRM`（EOS R5 C 素材，4096×2160）实测：

- 文件里**没有内嵌预览图** —— 前 96 MiB 与尾部 16 MiB 内可解析的 JPEG 数量为 **0**；
  `moov` 里只有 1 条视频轨 + 6 条音视频/时码轨 + 一个 Canon 私有 `uuid` 盒，没有图片轨。
  所以 R3D / BRAW 那种"读内嵌预览图出静帧"的路子在这里走不通。
- ffmpeg 6.0 **没有 CRAW 解码器**（FFmpeg trac #6765 自 2017 年 open），解不出画面。
- **但 ffprobe 能读出真实参数，而且很快**：耗时 **0.01 秒**（`moov` 在文件头部），
  读出 `时长 9.009s`、`时码 08:21:48:23`、`拍摄时间`、`4096×2160`。
  也就是说：**画面给不了，但时长/时码/分辨率是拿得到的**。
  （当时尚未启用；**1.2.4 已启用**。）

## [1.2.2] - 2026-09-17

> 本版主题：佳能机内 RAW 素材在队列页不再被写成"普通文件"。

### 新增

- **识别佳能 Cinema RAW Light（`.CRM`）**：EOS R5 C / C70 / C300 Mark III /
  C500 Mark II / C200 等机内 RAW 录制的容器（12-bit，机内有 LT / ST / HQ 三档）。
  队列页的「格式」列现在显示 **`CRM（Canon Cinema RAW Light）`**，
  并给出官方工具提示（Canon Cinema RAW Development / DaVinci Resolve）。

  边界说明（重要，别误解）：
  - **只做命名，不做探测。** ffmpeg 没有 CRAW 画面解码器
    （FFmpeg trac #6765 自 2017 年至今 open），所以 `.CRM` 没有缩略图。
  - **拷贝与校验一直不受影响。** 本工具搬的是字节，不是"它看得懂的视频"；
    认不出格式的私有 RAW（`.CRM` / `.R3D` / `.braw` / `.ari`）同样全字节落盘
    并通过独立重读校验。这一条现在有专门的回归测试守着。
  - 为什么先不开探测：`.CRM` 是 MOV 系容器，ffprobe 能读容器但读不懂 CRAW 编码，
    贸然放开会让报告写出 `none` 这类字符串，比"普通文件"更糟。
    正解是先补 CRAW（`codec_tag`）判定，并实测探测耗时。
    （后一条在 1.2.3 里补做了：实测 0.01 秒，见该版说明。）

## [1.2.1] - 2026-09-16

> 本版主题：界面做减法 —— 按钮不再抢眼，主题选择回归文字。

### 变更

- **主按钮不再用渐变**：从「主色 → 辅色」的对角渐变改为实心主色块，
  三套主题统一。辅色（粉）仍保留在进度条、侧栏选中态与下拉选中项上。
- **设置页主题选择去掉配色预览条**：三张主题卡片只剩主题名，
  选中态用主色描边 + 主色字色 + 加粗表达。主题切换依旧是点击立即生效。

## [1.2.0] - 2026-09-16

> 本版主题：出问题时沟通更省事，非中文用户看到的报告不再中英混排。

### 新增

- **导出诊断包**：设置页新增按钮，一键把最近三天的日志 + 版本/系统信息
  （应用版本、macOS 版本、芯片架构、ffprobe 可用性、数据库留档记录）
  打成一个 zip 存到用户选的位置。出问题不用再人工翻日志文件夹。
  （第二轮改进 #3）
- **持续集成配置**（`.github/workflows/ci.yml`）：代码推送到 GitHub 后，
  每次改动自动跑类型检查、代码规范与全部单元测试。（第二轮改进 #2；
  远端仓库按 2026-09-16 决定暂缓，配置已就绪）
- **队列页任务模式徽章**：仅校验任务在任务列表与详情中带「仅校验」标识，
  隔天分不清哪个是复核哪个是拷贝的问题解决。（第二轮改进 #4）

### 变更

- **引擎层错误与日志双语化**：拷贝引擎与任务管理器的全部用户可见
  错误、日志、报告附注改为按界面语言输出（`src/shared/messages.ts`，
  55 组文案）。英文界面下报告的错误清单不再中英混排。
  报告文案按任务运行时的语言落库（快照语义），之后改语言不影响已有报告。
  （第二轮改进 #5）
- **设置页数字输入改为失焦提交**：之前每敲一个键就写一次数据库
  （把 4 改成 5 会途经中间值落库）；现在输入过程只动本地状态，
  失焦或回车才提交并自动夹紧到合法区间。（第二轮改进 #6）

### 修复

- 版本号同步：1.1.0 打包时 `APP_VERSION` 常量未随 package.json 更新
  （安装包元数据是对的，但界面与报告显示的版本落后一档）。
  `tests/version.test.ts` 的一致性断言正是为此存在的，本次已按其报错补齐。

## [1.1.0] - 2026-09-16

> 本版主题：把「开发者工程」补成「能交给别人用的软件」。
> 依据《发布就绪度评估》（2026-09-15）逐项修复。

### 新增

- **仅校验任务模式**：选源与已有拷贝目录，只读取两侧并比对校验值，
  不写入、不删除目标盘任何字节。用于隔天复检、交接核对。
  （评估 P1 #9）
- 应用图标、`electron-builder` 打包配置（应用标识 `com.shanfly.securereel-dit`、
  视频类目、DMG 拖拽安装布局、最低 macOS 13.0）。（评估 P0 #1）
- **Intel + Apple 芯片通用安装包**（universal）。影视行业仍有大量 Intel 的
  Mac Pro 工作站，只打 arm64 会让这些机器装不上。（评估 P2 兼容性）
- **随包分发 FFmpeg / ffprobe**（FFmpeg 6.0 静态构建，双架构各一份，
  运行时按本机芯片选用）：别人装完即有首帧图与元数据，不再依赖本机 brew。
  来源与许可见 `THIRD_PARTY_NOTICES.md`，获取脚本 `scripts/fetch-ffmpeg.sh`。
  （评估 P1 #6）
- 报告 HTML **单文件自包含**：首帧图以 base64 内联，单独把 HTML 发出去也不会裂图。
  设 64MB 内联预算，超出部分保留 `frames/` 引用并在报告附注说明。（评估 P1 #10）
- 目标空间不足时**必须明确勾选确认**才能创建任务（原来只提醒不拦）。（评估 P1 #11）
- 日志自动清理：启动时删除 30 天前的按天日志。（评估 P1 #12）
- `CHANGELOG.md`（本文件）。

### 修复

- **命名冲突不再误伤整盘**（评估 P1 #8）：目标上已存在同名文件
  （大小不同，或同尺寸但内容不同）时，只让该文件在此目标上失败并计入冲突清单，
  同盘其余文件照常写入；此前一个撞名文件会导致整块好盘被隔离、后续全部停写。
  I/O 类故障（写入失败、校验不符）维持原有的整盘隔离策略不变。
- 数据库 `jobs` 表加列 `mode`（带增量迁移，老库自动补列，数据不受影响）。

### 移除

- 设置里的**「单目标并发文件数」开关**：该值从未被拷贝主循环读取过
  （引擎刻意保持单文件串行，对读卡器与数据完整性最友好），
  留着只会让用户误以为是自己没配对。旧数据库里存的该值会被无害忽略。
  （评估 P1 #7）
- 死代码 `paths.settingsFile`（设置实际存于 SQLite，该字段无任何使用）。

### 文档

- README / 使用说明改为以 **dmg 安装包为唯一对外交付方式**；
  `启动 SecureReel DIT.command` 明确标注为开发者本地脚本。（评估 P0 #2）
- 补齐 `LICENSE`（GPL-3.0 正文）与 `THIRD_PARTY_NOTICES.md`，README 引用不再 404。
  （评估 P0 #5）
- 项目纳入 git 版本管理。（评估 P0 #4）

### 仍待解决

- **签名与公证**：需要加入 Apple Developer Program（约 99 美元/年）。
  配置已就绪（`electron-builder.yml` 的 `identity: null` 在拿到证书后删除即可
  自动进入签名 + 公证流程）。在此之前，用户首次打开需在
  「系统设置 → 隐私与安全性」点一次「仍要打开」。（评估 P0 #3）
- `node:sqlite` 仍为 Node.js 实验性 API（长期技术债，随 Electron 运行时演进观察）。
- 界面层无自动化测试（评估排序最后，暂缓）。
