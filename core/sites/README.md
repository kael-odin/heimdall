# 站点配方（Site Recipe）

> 换一个站就要改代码，是这个项目最贵的税。配方把"站点知识"从代码分支挤进数据。

## 三层合并（后者覆盖前者）

| 来源 | 路径 | 是否入库 | 谁写 |
|---|---|---|---|
| 内置默认 | `src/site-profile.mjs` 的 `DEFAULTS` | ✅ 代码 | 开发者 |
| 运行时学到 | `workspace/<host>/site.json` | ❌ 产物（gitignore） | 工具自动写（`linker` 汇总） |
| 人工整理 | `sites/<host>.json` | ✅ 本目录 | 你 |

**人工整理压过自动学到** —— 否则一次跑歪的自动记录会盖掉人工修正。

## 职责边界

- **框架知识 → `src/adapters/index.mjs`**：由框架指纹推导的通用规则
  （例如 nextjs 的 CSSOM 前缀偏移 `/_media/ → /_next/static/media/`）。
- **站点知识 → 本目录**：这个站特有的东西 —— 弹窗选择器、挂件黑名单、stub 策略、队列排除项。

## 字段速查

```jsonc
{
  "adapter": "auto",              // auto | nextjs | vue-vite | generic（强制指定可跳过探测）

  "capture": {
    "waitUntil": "domcontentloaded",  // domcontentloaded | load | networkidle
                                      // 持续轮询/长连接的站点用 networkidle 会永不达成
    "settleMs": 3000,                 // 懒加载扫掠后的静置时间
    "scrollSweep": true,              // 截全页前先滚一遍触发懒加载
    "consentButton": null,            // 覆盖"接受 Cookie"按钮的文案正则
    "removeSelectors": []             // 抓 DOM 前直接删掉的元素（选择器数组）
  },

  "css": {
    // CSSOM 序列化会丢前缀之类的问题，按站点补规则（from 是正则源串）
    "refRewrites": [{ "from": "^/media/", "to": "/_next/static/media/" }]
  },

  "live": {
    "stubStrategy": "magic",          // magic = 递归 Proxy stub 一切挂件全局（默认）
                                      // conservative = 不 stub，挂件经代理真跑
                                      // 症状：页面白屏/挂死 → 改 conservative
    "stripScriptPatterns": [],        // 追加要剥除的脚本 URL 片段
    "thirdPartyAllow": []             // 允许直连的站外域（默认全部走镜像）
  },

  "queue": {
    "excludeTypes": ["auth", "legal"] // 批量克隆时跳过的页面类型
  },

  "notes": "写给人看：为什么这么配，踩过什么坑"
}
```

## 怎么用

```bash
# 看某个站当前生效的配方（含来源标注）
node core/src/cli.mjs profile <host>

# 工具跑完批量后会写 workspace/<host>/site.json（运行时学到的）
# 人工确认无误 → 复制关键项到 core/sites/<host>.json 固化下来
```

## 为什么"空配方也要有文件"

`thordata.com.json` 里只有一句 notes。这是刻意的：站点一旦需要调参，
**加一个文件**比**改一处代码**便宜得多，也不会让 `adapters/` 长出一堆 if。
