# dsh-card-summon

把 [Chub.ai](https://chub.ai) 上的 AI 角色卡「召唤」进当前 DSH 会话：抓卡 → 渲染成系统提示段 →
该会话后续每轮都以这个角色的身份说话。**未召唤的会话完全不受影响**（求值器返回空串，零注入）。

## 怎么用

**① 面板**（推荐）：对话框输入区右侧点「🎭 角色卡」→ 打开面板 → 搜角色名 → 点卡片即召唤。
当前召唤显示在面板顶部，点「解除召唤」恢复默认人格。

**② 对话里说**：直接说「召唤 Frieren」或「帮我搜一下 xxx 的卡」，我会用下面的工具完成。
召唤生效后，你正常说话即可 —— 我会以该角色的人格、语气、说话方式回应。

**移动端**：卡片**长按**查看详情（桌面右键），短按仍是召唤；滑动列表会取消长按判定。

## 中文卡怎么找（重要）

插件支持**两个数据源**，面板上有数据源下拉：

| 源 | 说明 | 量级 |
|---|---|---|
| **中文站**（思畅 `sichang.xyz`） | **中文原生卡库**，卡名与人设都是中文 | 约 84 张 |
| **Chub** | 国际站，量大但以英文为主 | 数万张 |
| **全部**（默认） | 两源合并，中文站的卡带「中」徽标 | — |

**如果搜出来全是英文卡**，原因通常是：你在用 Chub 源搜英文词。三个办法：

1. **切到「中文站」** —— 直接看原生中文卡（推荐）。
2. **用中文关键词搜 Chub** —— 实测 `修仙` 命中 153 条、抽检 100% 是真中文卡；`中文` 第 1 页 83%。搜索框直接打中文即可。
3. **用语言下拉选「中文」** —— 按 Chub 的 `lang_id` 标注过滤（实测精确率 93%、**漏卡约 3%**，因为标注是作者自选的）。

⚠️ 一个容易踩的坑：**Chub 的「中文」标签（`tags=Chinese`）筛的是题材，不是语言。** 实测抽检 30 张里只有 3 张内容真是中文，其余是「以中国角色为主题、但用英文写」的卡（Xianxia fantasy、Diao Chan 之类）。别用标签找中文卡。

## 远程卡库（GitHub 私有仓库，默认优先）

配了 `remoteRepo` 就**默认走远程** —— 本地卡库只作降级（远程不可达/无网时）。

```
cordis.patch.yml:
  remoteRepo: "jipika/dsh-card-library"     # owner/repo
  remoteBranch: "main"                      # 索引 + 卡正文
  remoteImagesBranch: "images"              # 封面（13GB，单独分支）
```

仓库结构（三样分开）：

| 分支 | 内容 | 大小 |
|---|---|---|
| `main` | `index.json.gz`（全文索引，含可搜正文摘要） | 24 MB |
| `main` | `manifest.json`（`src ↔ card ↔ cover` 映射） | 4.2 MB |
| `main` | `cards/<分类>/<id>.json`（11480 张卡正文） | 1.3 GB |
| `images` | `<月份>/<分类>/*.png`（11570 张封面） | 13.14 GB |

**首次使用成本**：拉索引 24MB + manifest 4.2MB（落盘缓存，6 小时内不重拉）。之后：
- 搜索：走缓存索引，毫秒级
- 取卡：单张按需拉（几十 KB）
- 封面：单张按需拉（约 1MB，走 96KB 截断）

### 私有仓库的三个坑（都实测踩过）

1. **`raw.githubusercontent.com` 必须带 token，且无 token 返回的是 `404` 而不是 `403`**
   —— 极易误判成「文件不存在」。token 优先取配置的 `remoteToken`，否则回退 `gh auth token`。
2. **`api.github.com/contents` 对 >1MB 的文件不返回 `content`**（只给 sha），
   所以本插件一律走 raw，不要用 contents API 取内容。
3. **manifest 的 `cover` 字段自带 `images/` 前缀**（`images/6-7月/xxx.png`），
   而 `images` 分支的根就是月份目录 —— 拼接时必须剥掉这个前缀。

## 本地卡库（PNG 卡目录，降级用）

除了两个线上源，还支持**扫本地卡库**。适合那种整包下载的卡合集。

### 启用

在 `cordis.patch.yml` 里配 `localRoot` 指向卡库根目录，然后：

```
card_local_scan()        # 建索引（约 30 秒 / 1.1 万张）；之后查询走内存，不重复扫盘
```

索引只存**元数据**（卡名/分类/月份/人设长度/世界书条目数…），**不复制卡正文** —— 13GB 的卡库只生成 4.5MB 索引。

### 多维度筛选（可任意叠加）

```
card_search({ source:"local", categories:["修仙"], minContent:50000, minBookEntries:50, sort:"contentDesc" })
```

| 维度 | 说明 |
|---|---|
| `categories` | 目录分类（如 修仙 / 古风 / 同人 / 后宫 / 萝莉…） |
| `months` | 月份目录 |
| `fileTags` | 文件名标签（如「蒸汽朋克」） |
| `minContent` / `maxContent` | **内容总量**（人设+开场白+世界书）← 推荐用它 |
| `minBookEntries` | 世界书条目数（想找设定厚的卡就用它） |
| `minDynEntries` | **可触发**世界书条目数（非 constant 且带 keys）← 想找「召唤后 keys 触发用得上」的卡就用它（**仅工具侧**，面板没有对应控件） |
| `hasLorebook` | 只要带世界书的 |
| `sort` | `contentDesc` / `bookDesc` / `dynDesc`（可触发最多）/ `personaDesc` / `mtimeDesc` / `name` |

先空查询看有哪些分类可选（返回值里带 `localFacets` 分面统计）。

### ⚠️ 三个必须知道的事实（都实测过）

**① 别用「人设长度」当筛选条件。** 实测 **48.4% 的卡 `personality` 字段为空**，内容全在
「开场白 + 内嵌世界书」里（84% 的卡带世界书）。所以插件提供了 `contentLen` 作为综合指标；
并且本地卡的人设为空时，会自动从**世界书的常驻条目**（`constant: true`，作者指定要一直生效的设定）
提炼出人设兜底 —— 否则召唤出来会是一句「这张卡没有给出 personality」。

**② `keyword` 只匹配卡名与路径，搜不到人设正文。** 因为索引不存正文（不然要复制 13GB）。
想按正文找：先用元数据缩小范围，再对候选逐个 `card_read`。

**③「有世界书」不等于「keys 触发用得上」。** 两者差着一倍：
实测 11480 张里 **9564 张（83%）带世界书**，但其中能进动态候选（非 `constant`、带 `keys`、正文非空）
的只有 **5454 张（47.5%）**，合计 145211 条可触发条目。薄世界书（1–4 条）里**大多数全是 `constant`**
—— 那些走「提炼人设」这条路，不吃 `keys`。所以别拿「世界书 21 条」当「召唤后会浮出 21 段设定」，
要看 `dynEntries`（面板卡片上的「可触发 N」徽标就是这个数）。

面板上**没有**按可触发数筛选的控件 —— 早期版本试过加「可触发≥ / 排序」两行 chips，
实测在窄面板里太占竖向空间，已移除；要按这个维度筛就用工具侧的 `card_search({source:"local", minDynEntries:3})`
或排序 `sort:"dynDesc"`。卡片徽标保留，因为它是「一眼看出这张卡值不值得召唤」的那条信息。
`/status` 的 `dynamicEntries` 是**召唤后**的同一个口径（那张卡有几条待撞）。

### 实测概况（1.2 万张的参考库）

```
11480 张入索引 | 96 张非卡图片（自动跳过） | 索引 58.8 MB | 建索引 34 秒
分类 33 个 | 月份 6 个 | 含世界书 9592 张（84%）
规格：chara_card_v3 9208 / v2 2128 / v1 144
可触发世界书（非 constant 且有 keys）：5454 张（47.5%）| 可触发条目合计 145211 条
  分布：0 条 6026 张 ｜ 1-4 条 1677 ｜ 5-19 条 2255 ｜ 20-49 条 865 ｜ 50-99 条 369 ｜ 100+ 条 288
```

## 酒馆对齐：模板宏、快捷按钮、动态世界书

三件事都是让卡的原文**按酒馆的语义正确落地**。默认全开，不需要配置。

### ① 模板宏（`{{user}}` / `{{char}}`）

角色正文里普遍带酒馆的模板宏。实测 300 张真实中文卡：**86% 带宏、共 27123 处**，
其中 `{{user}}` 24849 处、`{{char}}` 941 处，另有 `{{User}}` 等大小写变体、
`{{roll 1d6}}` 这类标准宏，以及作者自造的自定义变量。

插件按酒馆语义分三类处理：

| 类 | 例子 | 处理 |
|---|---|---|
| **A 已求值** | `{{user}}` `{{char}}` `{{original}}` | 替换成你 / 角色的真实名字 |
| **B 标准宏** | `{{roll 1d6}}`、`{{setvar::…}}`、`{{time}}`、`{{date}}` … | **原样保留**（求值它们要跑 STscript，超出本插件范围） |
| **C 自定义变量** | `{{数字}}`、`{{角色名}}` … | 「变量」页填了值就替换；没填**原样保留**并在注入段里列出来 |

C 类没填时，注入段会显式加一句「以下自定义变量未赋值，正文里保留原样：…」——
让模型知道那是待填占位符，而不是把它当成正文的一部分。

**「变量」页**（面板里的 tab）：全局值（`user` / `char`，对所有卡生效）+ 卡级值
（只对这张卡生效），卡级优先。落盘 `~/.dsh/card-summon/vars.json`。

### ② 快捷按钮

一句话说清它是什么：**你预先写好一句话，之后点一下就以你的身份发出去**（比如
「继续」「描述一下你现在看到的」），不用每次手打。全局与卡级分开累加，每层最多 20 个，
落盘 `~/.dsh/card-summon/quick-replies.json`。

界面上不假设你用过酒馆：页首有一句用途说明，两个作用域各自标了适用范围
（「这张卡专用」/「所有卡通用」），正文是多行输入（一条最长 2000 字）。

入口有**两处，都在面板/详情里，对话框那块不留任何东西**（早先版本在输入框右侧挂过一条
chip，已按用户要求撤除）：

| 入口 | 位置 | 用途 |
|---|---|---|
| ⚙ 设置按钮 | 面板顶部、「解除召唤」旁边 | 召唤后才有；点开进「按钮」页，增删改 + 发送 |
| 「按钮」tab | 右键卡 → 详情浮层 | 同一页；**手机上改为长按卡片**触发详情 |

投递走宿主的 `agent.followup()`：闲时立刻开始新一轮（提示「已发出」），
忙时排队（提示「已排队」）—— 排队是有意的，不会打断你正在进行的对话。

面板里的「按钮」tab **只在当前会话确实召唤了这张卡时才出现**。它是「跟这个角色说话时
一键发话」，没召唤就无从谈起 —— 右键任意卡都能看到这一页是错的。判定取 `/status` 的
`summon.fullPath`，阵容时那是逗号拼的一串，所以按卡**拆开比对**，不是全局开关：
召唤了 A 而你在看 B 的详情时，B 那里不该有这一页。

### ③ 动态世界书（`keys` 关键词触发）

世界书条目按**位置**分流（酒馆 `world_info_position` 语义）：

- **`constant: true` 的常驻条目** —— 一直生效：`before_char` 进 `worldBefore` 槽、`after_char`
  进 `worldAfter` 槽、`atDepth`/作者注进 `lore` 槽。人设字段为空时，它们拼起来作为
  `persona` 的兜底（`personaFromBook`），同一条不会注入两次。
- **带 `keys` 的条目** —— 酒馆里是「对话里出现这些关键词才注入」。每轮拿**最近 2 条消息**
  （酒馆默认 `world_info_depth=2`）去撞 `keys`，命中就把条目原文追加到 `lore` 槽。
  副键（`secondary_keys`）按 `selectiveLogic` 判定；`selective: false` 的条目忽略副键。

预算**独立 4000 字符**（不挤静态人设的额度）。一条放不下就跳过它、继续看后面的短条目，
**绝不切断正文** —— 半句设定比没有更坏。

实测 194 张真实卡：**92 张（47%）有可触发的候选条目**、共 1615 条；其中 95 条（5.9%）
正文超过 4000 字符，会被预算直接跳过。想看某张卡有多少候选条目，查
`GET /dsh-card-summon/status?sessionId=…` 的 `dynamicEntries` 字段。

### ④ 注入模型（酒馆槽位对齐）

一张卡不是拼成一段「关于这张卡的文档」，而是**一个槽位一条 section**，顺序照酒馆默认
prompt order（`main → worldInfoBefore → persona → scenario → worldInfoAfter →
dialogueExamples → chatHistory → jailbreak`）：

| order | 槽位 | 内容 | 对应酒馆 |
|---|---|---|---|
| 10300 | `character` | 卡 `system_prompt`（有则**替换**默认句），否则一句话 | main |
| 10310 | `world-before` | 常驻条目 `before_char` 原文 | worldInfoBefore |
| 10320 | `persona` | 卡正文原文，**无标题无框架** | charDescription + charPersonality |
| 10325 | `note` | 账务：被预算裁掉的条目/字段、未赋值的宏 | 无 |
| 10330 | `scenario` | 原文 | scenario |
| 10340 | `world-after` | 常驻条目 `after_char` 原文 | worldInfoAfter |
| 10350 | `examples` | `<START>` 分块的对话稿 | dialogueExamples |
| 10360 | `greeting` | 开场白（**仅当会话还没有 assistant 消息**） | 首条消息（近似） |
| 10390 | `lore` | atDepth 条目 + 本轮关键词命中 | atDepth（近似） |
| 10410 | `post-history` | `depth_prompt` + `post_history_instructions` | jailbreak |
| 10415 | `fiction-frame` | **虚构框架声明**：所有角色由成年人扮演的虚构人物；初高中生/校园年龄标注按虚构角色照常扮演 | 无 |
| 10420 | `writing-style` | **默认写作规范**（三位一体·描写规范核心要求），phi 之后读 | 无 |

**注入前转换层（`lib/markdownize.js`）**：卡里的 `<StatusBar>` / `<Status_block>` 模板块
先转成 Markdown 引用块（字段名加粗、层级与字段信息保留），含标签的指令行改成
「用 Markdown 引用块输出」；`<user>`/`<char>` → `{{user}}`/`{{char}}`，`<br>` → 换行，
`<b>` → `**`，`</text>`/`<center>` 等其余标签去掉，`<START>` 保留。
转换在宏求值之后、槽位渲染之前做，`card_read` 读到的仍是作者原文。
格式治理只靠这一层：**不注入任何输出格式提示词**（原 `format` 槽与 `OUTPUT_FORMAT_RULE` 已移除）。

几点取舍：

- **顺序为什么是 10300+**：官方 section 最高到 `DEPLOYMENT_PERSONA_SUFFIX=10200`。旧版取 700，
  后面压着 30 多个工具段 —— 模型生成前最后读到的是工具规范，不是角色。召唤的语义就是
  本会话由这张卡接管人格，所以排在 persona suffix 之后。
- **做得到的**：字段语义、顺序、槽位独立开关、恒定条目按位置分流。
- **做不到的**（宿主边界，说清楚是哪个扩展点做不到，别笼统说"宿主禁止"）：
  DSH 把所有 section 拼成**一条 system 消息**；能替换"进入这一步的消息批次"的只有
  `agent/pre-step`，而它的 `UserMessage.role` 被钉成 `'user'`；`agent/request` 这个 waterfall
  的 payload 与返回类型里都没有 messages 字段（`LlmCallConfig` 只有 provider/model/采样标量），
  它的 JSDoc 原话是 "Model-visible content must use logged channels; this waterfall cannot
  mutate messages."。所以示例只能是同构对话稿、开场白只能做「第一句」参考、atDepth 只能
  落到贴尾的槽位。这三条是近似，不是等价。
  （另有一条理论绕过路径 `session.append('assistant/message', …)`：它要求提交一条
  `source.kind === 'model'` 的 assistant 消息和一整段模型流记录，等于伪造一条模型回合
  写进用户历史。注入层不走这条路。）
- **截断**只按段落边界切，账务信息进 `note` 槽 —— **不再把「（…此处截断…）」写进角色正文**。

面板的注入预览仍显示按顺序拼好的整段；`/status` 与 `card_status` 会额外给出每个槽位的字符数（`slots`）。

## 两种「让角色上场」的方式

| 想要的效果 | 用什么 | 会不会改变我的人格 |
|---|---|---|
| 沉浸单聊：我**就是**这个角色 | `card_summon` | **会** —— 该角色接管会话人格 |
| 开团 / 群像 / 写文：我**演这些人** | `card_cast`（默认只读） | **不会** —— 我读卡，照着演 |

### 开团的两种姿势

**① 单模型分饰多角（`card_cast`，开箱可用）**
我一次读入多张卡，同时扮演全部角色，用 `【角色名】` 区分发言。
适合小队对话、写文、快速试戏。代价低，但所有角色由同一个模型演，风格差异有限。

```jsonc
// 只读：拿回每张卡的人设正文，不接管人格
card_cast({ members: [{fullPath:"a/b", role:"队长"}, {fullPath:"c/d"}] })

// 注入：把整个阵容写进系统提示，此后每轮保持
card_cast({ members: [...], inject: true })
```

**② 每个角色一个真 teammate（需要你明确要求）**
DSH 有 `spawn_teammate`，可以给每个角色一个**独立上下文、独立人设**的队友，真正并行推进。
`card_cast` 只读模式返回的每成员 `personality` 正文，**预期**可直接作为该 teammate 的 `prompt` 传入
（`SpawnTeammateRequest.prompt` 是 teammate 的初始请求，见 `agent-team/src/roster.ts` 的
`prompt: request.prompt` + `checkpointInitialPrompt`；**但本插件未实测跑通该传入**）。

⚠️ 两个前提：宿主 POLICY 要求「**用户明确要求**使用 teammate 时才创建」，所以这一步我不会自动做；
另外真队友更费 token / 时间。你说一句「用真队友开团」我就走这条路。

## 模型侧工具
| 工具 | 作用 |
|---|---|
| `card_search` | 搜卡（**三源**）。参数 `query`、`source`(all/sichang/chub/**local**)、本地筛选 `categories`/`months`/`fileTags`/`minContent`/`minBookEntries`/`hasLorebook`/`sort`、`langId`、`first`/`page` |
| `card_summon` | 召唤**单卡**进当前会话（接管人格）。参数 `fullPath`、`confirm` |
| `card_cast` | **组建阵容**（多角色，默认只读不注入）。参数 `members[{fullPath,role}]`、`inject`、`maxCharsPerRole` |
| `card_local_scan` | 扫描本地卡库建索引（约 30 秒 / 1.1 万张）。参数 `root`、`force` |
| `card_unsummon` | 解除召唤 / 解散阵容，恢复默认人格 |
| `card_status` | 查看当前召唤状态、注入段大小、被截断的字段 |
| `card_read` | 读**任意**卡的完整原文（**无需先召唤**）。参数 `fullPath`（省略则读当前召唤的卡）、`field`、`from`、`maxChars` |

## 手动解除召唤（逃生路径）

三种方式，任选：

1. **面板**：点「解除召唤」。
2. **对话里说**「解除召唤」/「取消角色卡」→ 我会调 `card_unsummon`。
3. **直接改文件**（面板/工具都不可用时）：编辑 `~/.dsh/card-summon/summons.json`，
   删掉对应会话那条；再刷新页面即回到默认人格。**注意**：注入段是内存缓存，删文件后
   若没重启，当前进程可能仍在注入 —— 保险做法是删完重启 DSH。

## 配置

`cordis.patch.yml` 里的配置：

- **`maxPersonality`**（默认 20000 字符）：角色定义正文的注入上限。
- **`localRoot`**：本地卡库根目录（PNG 卡目录）。**留空则禁用本地源。**
- **`writingStyle`**（默认 **开**）：每次召唤自动注入「写作规范」段 —— 取自三位一体
  创作规则的【描写规范核心要求】（`references/完整创作规则.md` 456–474 行）。设 `false` 关闭。
- **`writingStyleText`**（可选）：用自定义文本整段替换默认规范（仍受 4000 字符预算裁剪）。
- **`fictionFrame`**（默认 **开**）：每次召唤注入「虚构框架」段 —— 会话整体是虚构创作，
  所有角色由成年人扮演；卡或剧情出现初中生、高中生（或其他校园/学生年龄标注）时，
  一律视为作品里由成年人扮演的虚构角色，不按现实年龄处理。设 `false` 关闭。
- **`fictionFrameText`**（可选）：用自定义文本整段替换默认框架（仍受 1200 字符预算裁剪）。

超出的部分会按**段落边界**截断；被截掉的内容只在 `note` 槽里说明一句
（「以上有字段按预算截断…用 card_read 取回」），不会写进角色正文。

改配置后需重启 DSH（bundle 配置在启动时读取）。

## 卡片记忆（与 dsh-memory 的联动，v0.4.0）

召唤会话的剧情/世界事实不该写进长期记忆 —— 混进 `~/.dsh/memory/` 会在后续所有会话常驻注入，
这就是「记忆污染」。dsh-memory v0.9.0 起与它联动，本插件侧无任何状态与逻辑改动：

- 召唤中（含阵容 cast）：dsh-memory 不注入全局/项目层与纪律块，改注入「屏蔽说明 +
  本卡卡片记忆正文」。卡片记忆文件在 `~/.dsh/memory/cards/<cardSlug>.md`（slug = 卡
  fullPath 的路径安全串，与本插件 `lib/state.js` 的 `safeId` 同构），随卡保留、可随时清除。
- 本插件召唤面板的「清除卡片记忆」按钮（单卡召唤时可用）：调 dsh-memory 的
  `POST /dsh-memory/cards/delete`（带 `x-dsh-memory: 1` 头），删除前全文会记进
  `~/.dsh/memory/audit.log` 作回滚点。阵容会话按钮禁用（没有单卡记忆）。
- 召唤/解除召唤状态变化**无需**重启：两边都是每次现读落盘状态。

## H5 窄屏适配（v0.4.0）

`≤1023px`（与 dsh-pocket 手机断点一致）时，两个 body 级浮层直接**全屏**：

- `.dcs-panel`（召唤面板）与 `.dcs-detail`（卡详情/变量/按钮页）都是 portal 到 body 的
  fixed 浮层，inline 定位（left/bottom/maxHeight 等）在窄屏下会把 520px 面板锚出屏外 ——
  手机上点不到也放不下。media 块用 `!important` 四边归零 + `100vw/100dvh`（dvh 兜底 vh），
  `z-index:1300` 对齐 h5-adapter 给 body 级浮层的口径（压过 pocket 抽屉的 1200）。
- 面板内部补了窄屏换行兜底：召唤状态条（`.dcs-now`）与过滤行（`.dcs-row-filters`）
  `flex-wrap`，detail 头部卡名/fullPath 超宽省略号截断；卡片网格 `≤640px` 本就单列。
- safe-area：面板上下 `env(safe-area-inset-*)`。桌面端定位与 z-index（15/16）不动。

## 状态文件

```
~/.dsh/card-summon/
├── summons.json           会话 id → 召唤记录（含卡快照，重启后离线复活）
├── vars.json              模板变量：global{user,char} + 每张卡的卡级值
├── quick-replies.json     快捷按钮：items(全局) + perCard(卡级)
├── sections/<id>.md       上一次渲染的整段（**仅作兜底**：重启时优先用 cards/<id>.json
│                          按当前代码现算槽位，卡快照缺失才读回这份文本）
│                          ⚠️ **动态世界书的候选条目不走这里** —— 它是内存态，重启时由
│                          cards/<id>.json 现算（`dynamicSourceOf`）；卡快照缺失就退化成
│                          「仅静态注入」，静态人设不受影响（`tests/restart-check.mjs` 钉住）。
└── cards/<id>.json        卡原文（供 card_read 取回被截断的部分）
```

`vars.json` / `quick-replies.json` 都是**原子写**（写临时文件再 rename）且读改写串行化 ——
面板会并发写，非原子的写会互相截断。

段与卡缓存会随「已不再存在的会话」自动回收（在封顶裁剪之后跑，见 `lib/state.js` 的
`sweepSectionFiles`）。默认最多保留 200 个会话的召唤记录。

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 召唤后报 `unknown prompt variable "{{char}}"` / `malformed prompt variable reference` | **已修**（v0.1.1）。宿主对未注册的 `{{name}}` 直接抛错，而角色卡正文普遍带 `{{char}}`/`{{user}}` 等酒馆占位符。修法是给注入段设 `interpolate: false`。若你从更早的版本升上来，重启 DSH 即可。 |
| 面板搜不到卡 | 检查终端里 `[dsh-card-summon]` 开头的日志；Chub 是第三方站点，可能超时或被风控。重试即可。 |
| 召唤了但角色没生效 | 看 `card_status` 的 `injected` 是否为 0。若为 0 说明注入段没进内存（常见于刚重启后召唤记录还在、段文件被清）—— 重新召唤一次。非 0 时再看 `slots`：`persona` 那格若空，说明这张卡的人设字段确实为空（走 `note` 兜底）。 |
| 角色说话跑偏、像通用助手 | 先看 `card_status.slots`：`persona` 太小说明卡本身人设很薄；`note` 非空说明有条目被预算裁掉了。用 `card_read` 看原文确认，或调大 `maxPersonality`。 |
| 正文里还是显示 `{{user}}` | 该字段没被走到。注入面必须与替换面一致（含 `lorebook.entries[].comment`、`personaDerivedDropped[].label` 这些"边长"字段）—— 改替换逻辑时按输出枚举，别按输入字段猜。 |
| 快捷按钮点了没反应 | 看返回的 `mode`：`queued` 表示当前正在跑一轮，消息已排队，等这一轮结束就会发出去。若一直排队，确认会话没停在同一问上。 |
| 动态世界书不触发 | `GET /status?sessionId=…` 的 `dynamicEntries` 为 0 说明这张卡没有带 `keys` 的非 constant 条目（47% 的卡有）。另外条目正文超 4000 字符会被预算跳过。 |
| 面板按钮不出现 | client 半边改动需**重启应用**（只改 `lib/client.js` 内容则刷新页面即可）。 |
| 想彻底停用 | 从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里删掉 `dsh-card-summon`，然后重启。 |

## 四个已知坑（改这个插件前先看）

1. **Chub 的 200 不代表鉴权通过**。本站对无效凭据不返 401，而是给占位匿名身份
   （实测 `/api/self` 匿名返回 `id=-22358`、`user_name='You'`）。所以 `lib/chub.js` 里
   `fetchCard` 显式判「200 但 `node.definition` 为空壳」并抛错，不要只看状态码。

2. **头像别用 `cardPngUrl`**。那是内嵌 `chara` chunk 的完整卡 PNG，实测单张 **12.9 MB**；
   列表/头像一律用 `avatarUrl`（webp 缩略图，实测 **9 KB**）。20 张卡就是 258 MB vs 180 KB 的差别。

3. **每个 fetch 都必须带超时**。面板的 `doSearch` 开头有个 `inFlight` 闸（防重复请求），
   闸门**只在请求结束时**才放开。早先 `apiGet` 没有超时，于是**一次挂住的请求会把之后
   每一次搜索永久挡掉** —— 界面永远停在「搜索中…」，看着像卡死。现在统一走
   `apiFetch` + `AbortController`（默认 20 秒、搜索 60 秒，首次搜索可能要等后台载入
   58 MB 索引），超时换成可读文案而不是原生 `AbortError`。

4. **flex 滚动容器必须写 `flex:1;min-height:0`**。详情浮层的 `.dcs-detail-body` 一度只写了
   `overflow-y:auto`，子项于是按内容高度撑开、把浮层顶破 —— 表现是同一段文字上半截在框内、
   下半截露在外面且没有背景。主面板 `.dcs-body` 一直是对的（`flex:1;min-height:140px`），
   新加滚动区照抄它。

## 关于内容

插件不做内容过滤：卡的原文照注入，不追加软化提示、不因 NSFW 标签改写措辞。

唯一的例外不是过滤而是**知情** —— 若卡自身的元数据（标签/简介）出现可能与未成年相关的字样，
插件不会删改任何内容，但会要求用户显式确认后才继续（`card_summon` 返回 `needConfirm`，
面板弹确认框）。判断权在用户手里。

卡内容来自 Chub 上的公开发布，由创作者各自授权；**能否再分发取决于创作者授权与 Chub 的 ToS**，
本插件只做「把你选定的卡喂给你自己配置的模型」这条通路，不代为分发。

## 开发

```bash
# 全量（27 个文件，无 runner）：822 项断言（本机实测，2026-10-20）
for f in tests/*-check.mjs; do node "$f"; done

node tests/host-probe.mjs            # 80 项：求值器三态 / 路由 / 工具契约 / output.render 契约（需网络）
node tests/vars-check.mjs            # 89 项：宏三分类、替换面全覆盖、vars.json 读改写、/vars 路由
node tests/qr-check.mjs              # 59 项：快捷按钮数据层、/qr 路由、/qr/send 真实投递
node tests/lore-check.mjs            # 54 项：动态世界书候选筛选、命中与预算、recentTextOf 取样
node tests/client-runtime-check.mjs  # 89 项：假 React 跑 client 半边（面板 / 变量页 / 召唤判定 / 长按手势 / 请求超时）
node tests/restart-check.mjs         # 21 项：重启恢复必须连动态世界书候选一起恢复（离线、不打网络）
node tests/local-check.mjs           # 51 项：索引字段与筛选（含 dynEntries 子集关系、minDynEntries、dynDesc）
node tests/persona-budget-check.mjs  # 15 项：世界书常驻条目的注入预算、整条跳过与 dropped 上报
node tests/remote-persona-check.mjs  # 12 项：remote 取卡路径必须现算 personaDerived（需网络 + gh auth token）
node tests/writing-style-check.mjs   # 23 项：默认写作规范（默认注入 / 位置 / 可关闭 / 可替换 / cast 生效）
node tests/fiction-frame-check.mjs   # 28 项：虚构框架（默认注入 / phi 与 style 之间的序位 / 可关闭 / 可替换 / cast 生效）
node tests/convert-check.mjs         # 27 项：注入前转换层（状态栏 → 引用块 / 标签清洗 / 世界书条目 / 不丢字段）
```

`interpolation-check.mjs` 需要 `/tmp/dsh-src` 下的官方编译产物；依赖没装时它**明说跳过**
（⊘ 而不是假装通过），不算失败（上面的 822 已不含它）。

`vars-check` / `lore-check` 的最后一段会**扫真实卡库**（`CARD_ROOT` 环境变量，默认指外置盘）
做批量验收：宏残留必须为 0、候选条目与命中口径必须对得上。盘不在就跳过并明说，不假装通过。

**改完 `index.js` / `lib/*.js` 必须重启 DSH 才生效**（host 半边不走 HMR）。
重启后**槽位会按当前代码从 `cards/<id>.json` 现算**，所以改了注入模型不必重新召唤
（`sections/*.md` 只是卡快照缺失时的兜底）。但**改了卡级变量仍要重新召唤或等变量页重建**，
因为宏是在渲染那一刻求值的。
改动前建议整目录复制一份备份。

回归闸的三条硬约束（2026-10-15/16 修 BUG 时补上，别删）：
① `index.js` 的 `jsonRender` 必须保持 `(_args, value) => ContentBlock[]` —— 宿主契约见
`packages/core/tools/src/index.ts:218`（返回数组）与 `:1845`（第 1 参是 args）。写错会让**全部
8 个工具**一起报 `content.filter is not a function`。
② `lib/local.js` 的 `personaFromBook` 只能「整条进出」，不许句中硬切 —— 半句话的设定比没有更坏，
它会把角色人格截成自相矛盾的版本且无任何报错。
③ **`personaDerived` 是派生字段，任何取卡路径都必须现算，不许透传快照**（见 `withFreshPersona`）。
配套地，三个预算必须同量级：`local.js` 的 `maxBookPersona`（提炼）、`inject.js` 的
`BUDGET.personaDerived`（注入兜底）、`BUDGET.personality`（非派生路径）。任一处偏小，
上游补齐的人设就会被下游悄悄切掉，症状与原始 BUG 一模一样 —— 本轮连踩两次。
④ **求值器不许做 IO**（它每轮都跑）：动态世界书的候选条目必须在召唤那一刻提取好、
连正文挂在内存的 `dynSource` 上，求值器只做字符串匹配。相应地，**重启恢复必须现算
`dynSource`**（`index.js` 的 apply 恢复循环从 `cards/<id>.json` 走 `dynamicSourceOf`）——
漏了它，重启后 `keys` 触发会静默失效，而 `/status` 的 `dynamicEntries` 报 0 与
「这张卡压根没有候选条目」完全无法区分。回归闸：`tests/restart-check.mjs`。

探针用假 ctx 跑 `apply()`，不需要重启 DSH；其中搜索与召唤两项会真的打 Chub。

---

## ☕ 赞赏支持

如果 dsh-card-summon 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
