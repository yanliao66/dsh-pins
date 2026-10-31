# 记忆钉 · dsh-pins

[![CI](https://github.com/yanliao66/dsh-pins/actions/workflows/ci.yml/badge.svg)](https://github.com/yanliao66/dsh-pins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[English](README.en.md) | **简体中文**

> 钉一次，之后每个会话都记得。

`dsh-pins` 是给 DeepSeek Harness（下称 DSH）做的**跨会话共享便签板**。它解决一个具体的痛点：
你每次开新会话都要重复交代同样的偏好、约定和提醒（用中文回复、先跑测试、别动那个目录……）。
记忆钉把这些话钉在一块板上，之后：

- **Agent 每次请求都带着它**——板子非空时自动注入系统提示；
- **Agent 能自己读写它**——`memory_pins` 工具（列出 / 钉住 / 修改 / 移除 / 开关注入）；
- **你能在输入框下方看到并编辑它**——输入框底部那行只占一枚小徽章（📌 记忆钉 · 3），与宿主的
  上下文计量器等元素并排；点开后在**输入框上方**浮出面板，不占用、也不遮挡底部那一行（Token 用量、
  会话统计等）。

用户和 Agent 操作的是同一块板子、同一套校验、同一个 revision 计数，不会各说各话。

```
        ┌───────────────────────────────┐
        │ 📌 记忆钉   3 条         [×]  │  ← 点徽章后：在输入框上方浮出
        ├───────────────────────────────┤
        │ • 回复用简体中文       [pref] ×│
        │ • 提交前先跑 node --test      ×│
        │ [ 钉一条跨会话都记得的事… ] 钉住│
        │ ⬤ 注入系统提示       42/2400 字│
        └───────────────────────────────┘
   ┌──────────────────────────────────────────┐
   │  输入框                                   │
   └──────────────────────────────────────────┘
   📌 记忆钉 ③     上下文 12% · Token 用量 · 会话统计   ← 底部那行：徽章只占自身宽度
```

## 它由哪些部分组成

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 激活插件：读取/写入板子、注册 `/api/dsh-pins/*` 路由、注册 `memory_pins` 工具、贡献系统提示段 |
| Host | `store.js` | 纯函数数据层：校验、状态迁移、提示块渲染（可单测，不依赖宿主） |
| Client | `client.js` | 浏览器半边：`conversation.composer.dock` 里的一枚紧凑徽章 + `conversation.input.overlay` 里向上浮出的面板，调用同源 API |
| 资源 | `locale/*.json`、`icon.svg` | 插件管理页的标题、描述与图标 |

插件以 **bundle** 形式声明：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
其中插入一行 `dsh-pins`；`dsh.client.platform = web` 让宿主把 `client.js` 作为浏览器模块
（`/plugins/dsh-pins/client.js`）提供给 Web GUI。一行即可同时挂载两个半边。

## 数据与限制

板子存在 `$DSH_HOME/dsh-pins/pins.json`（`$DSH_HOME` 缺省为 `~/.dsh`）：

```json
{
  "version": 1,
  "revision": 3,
  "pins": [
    { "id": "p_8f2c1a4d", "text": "回复用简体中文", "tag": "pref",
      "createdAt": 1793373831004, "updatedAt": 1793373831004 }
  ],
  "settings": { "inject": true }
}
```

- 最多 **24 条**，单条 **400 字**，标签 **24 字**；重复文本不会重复钉。
- 写盘是原子的（临时文件 + rename）；文件损坏时自动改名为 `pins.json.corrupt-<时间戳>` 并以空板启动。
- 注入预算 **2400 字**：超出时按钉入顺序截断，并补一行“还有 N 条未展示，用 `memory_pins` 读取”。
- 关掉“注入系统提示”后板子和工具都还在，只是不再进提示词。

## HTTP API（仅本机）

所有路由都走本机信任围栏：socket 地址与 `Host` 都必须是回环地址、不得带 `cf-connecting-ip` /
`x-forwarded-for`、跨站标记必须为同源；否则一律 `403`。响应统一 `{ ok, ... }`，失败带
`{ ok:false, error, message }`。

| 方法与路径 | 作用 |
|---|---|
| `GET /api/dsh-pins/pins` | 读整块板（pins、settings、stats） |
| `POST /api/dsh-pins/pins` | `{ text, tag? }` 钉一条；重复文本返回 200 + `duplicate:true` |
| `PATCH /api/dsh-pins/pins` | `{ id, text?, tag? }` 改一条（`tag:null` 清标签） |
| `DELETE /api/dsh-pins/pins?id=…` | 移除一条 |
| `POST /api/dsh-pins/settings` | `{ inject: boolean }` 开关注入 |
| `GET /api/dsh-pins/health` | 自检：版本、数据文件路径、revision、条数 |

## Agent 工具 `memory_pins`

| action | 参数 | 结果 |
|---|---|---|
| `list` | — | 每条钉子的 id、文本、标签 + 注入开关 |
| `add` | `text`、`tag?` | 新钉子（重复文本返回已有那条） |
| `update` | `id`、`text?`、`tag?` | 更新后的钉子 |
| `remove` | `id` | 已移除的钉子 |
| `set_inject` | `inject` | 注入开关的新状态 |

工具描述明确要求：只钉**持久**的偏好/约定/提醒，不钉瞬时任务状态，不臆造用户没要求的钉子。
系统提示段同样写明这些钉子来自用户、是长期上下文、冲突时以当前请求为准。

## 安装

```bash
git clone https://github.com/yanliao66/dsh-pins
```

然后在 DSH Web GUI 的 **插件 → 添加插件** 里填上面目录的绝对路径（或直接填
[Releases](https://github.com/yanliao66/dsh-pins/releases) 里的 `dsh-pins-1.0.0.tgz`），
安装后启用即可。宿主会把它作为 `link:` 依赖写进 profile，并把 `dsh-pins` 追加进
`dsh.profile.bundles`；HMR 会在不重启的情况下重组插件树。

其它 profile 也可以用 CLI 安装（Desktop 的 profile 由应用托管，走上面的界面）：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-pins
```

卸载：插件页的 **移除**；数据文件 `$DSH_HOME/dsh-pins/pins.json` 会保留，重新安装后钉子还在。

> **安装位置即依赖位置。** profile 里记的是目录路径。移动或删除已安装目录会让插件在下次启动时
> 加载失败；要换位置，先移除再从新路径安装一次即可（数据文件不受影响）。

## 设计取舍

- **提示词注入用 variable + section，而不是每次拼接文本**：段落文本固定为 `{{memory_pins}}`，
  由变量在每次组装时读取当前板子。空板或关闭注入时变量返回空串，空段落会被宿主丢弃——
  所以没钉子时**一个 token 都不花**。
- **面板与工具共用一条 `mutate()` 写队列**：并发写入不会互相覆盖，revision 单调递增；
  内容没变（重复钉、无效编辑）时返回同一个 state 引用，于是连磁盘都不写。
- **位置与尺寸服务于"不抢底部"**：`conversation.composer.dock` 是宿主的横向 flex 行
  （`justify-content:center; gap:12px`，上下文计量器就在这一行），所以这里只放**自适应宽度的小徽章**；
  板子本体渲染在 `conversation.input.overlay`——宿主把该槽锚在输入框卡片顶边的零高度元素上，
  于是面板 `position:absolute; bottom:calc(100% + 8px)` 向**上**展开，宽度封顶 360px、
  高度封顶 `min(52vh,440px)` 且内部滚动。收起时底部那行只多出徽章自身的宽度，展开时面板也
  永远不会盖住底部那行。
- **样式只用宿主主题 token**：`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-specific-menu`、
  `--dsw-elevation-panel`，以及宿主输入框自身声明的 `--dsh-composer-*` 宽度契约，
  因此深浅色切换、换肤、窗口缩放都跟着宿主走，不引入任何字面颜色。
- **客户端不依赖任何宿主 Client 包**：只用 `require('react')` 和 `fetch`，
  面板崩溃不会连累别的插槽。
- **零宿主内部导入**：Host 半边不 import 任何 `@deepseek-ai/*` 包，工具定义手写 JSON Schema，
  所以安装源的解析边界最小。

## 自测

```bash
cd dsh-pins
node --check index.js && node --check client.js && node --check store.js
node --test test/        # 20 个用例
```

- `test/store.test.mjs`（11）：校验、限额、去重、revision、注入预算、损坏文档降级、快照……
- `test/host.test.mjs`（9）：用假的 Cordis 上下文真实激活 `apply()`，断言 3 条路由 / 1 个工具 /
  1 个提示段注册正确，再用伪请求跑通增删改查、注入开关、信任围栏 6 种拒绝、错误码映射、
  跨激活持久化与损坏文件隔离——全程不需要启动 DSH。

## 许可

MIT。图标为本插件原创 SVG。
