# 测试报告 · Xspark 验收工作区 · web

> 运行 `qa-20261104-205755-ddbc` · 2026-11-04 12:57 · https://www.xspark.cn/ · 环境：production · 未登录

**这次没有需要提单的问题。**按以往裁决过滤 2 条；可容忍 55 条未入单。

| 建议提单 | 已知仍在 | 按裁决过滤 | 可容忍 | 环境问题 | 检查点待修 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 55 | 0 | 0 |

## 建议提单

无。

## 无参照物检测（57 条）

这些检查不需要参照站：只读页面自身的 DOM、计算样式、性能条目与页面文字，判断「页面能跑但看起来/用起来不对」。每条都带定位与实测值；按类别汇总如下，明细在「建议提单 / 可容忍」两节里。

| 类别 | 命中 | 其中建议提单 |
| --- | ---: | ---: |
| 布局与响应式 | 40 | 0 |
| 性能 | 17 | 0 |

## 按以往裁决过滤掉的（2 条）

每条都能追溯到当时的裁决。觉得哪条规则不对，用 `heimdall qa verdict --revoke <规则编号>` 撤销。

| 规则 | 裁决 | 理由 | 命中 | 例子 |
| --- | --- | --- | ---: | --- |
| `conv:star-alias` | 团队约定 | 评价卡片用「星火」昵称可接受 | 2 | 文字被裁切：Xspark星火启幕 · 静态ISP限时半价 [5折开通+免费测试] 快速领取 |

## 可容忍，未入单（55 条）

<details><summary>展开</summary>

- F2 点击目标过小 48×21：产品 · /（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_00373ae8dc89`
- F3 点击目标过小 76×21：使用场景 · /（1440x900） · 在 1440px 宽下可点区域 76×21px，低于 24px · `fp_dee5528d1fa2`
- F4 点击目标过小 48×21：资源 · /（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_79d2fe0caf86`
- F5 点击目标过小 84×19：企业测试申请 · /（1440x900） · 在 1440px 宽下可点区域 84×19px，低于 24px · `fp_184526bdfb76`
- F6 图片分辨率远大于显示尺寸：/figma/home/integration/logo-adspower.webp · /（1440x900） · 原图宽 347px，显示宽 110px（3.2 倍） · `fp_8aac024ccbbf`
- F7 图片分辨率远大于显示尺寸：/figma/home/integration/logo-hubstudio.webp · /（1440x900） · 原图宽 383px，显示宽 119px（3.2 倍） · `fp_2eaa27e14e3a`
- F8 图片分辨率远大于显示尺寸：/figma/home/integration/logo-dolphin.webp · /（1440x900） · 原图宽 365px，显示宽 116px（3.2 倍） · `fp_16a51ab26654`
- F9 图片分辨率远大于显示尺寸：/figma/home/integration/logo-bitbrowser.webp · /（1440x900） · 原图宽 323px，显示宽 102px（3.2 倍） · `fp_248110c9d447`
- F10 点击目标过小 48×21：产品 · /product/isp-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_04a7ffd60a0d`
- F11 点击目标过小 76×21：使用场景 · /product/isp-proxies（1440x900） · 在 1440px 宽下可点区域 76×21px，低于 24px · `fp_9dc530839289`
- F12 点击目标过小 48×21：资源 · /product/isp-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_fe0409c3a006`
- F13 点击目标过小 84×19：企业测试申请 · /product/isp-proxies（1440x900） · 在 1440px 宽下可点区域 84×19px，低于 24px · `fp_29deeba35653`
- F14 图片分辨率远大于显示尺寸：/figma/product/hero/hero-visual.png · /product/isp-proxies（1440x900） · 原图宽 1200px，显示宽 600px（2.0 倍） · `fp_87c775535640`
- F15 图片分辨率远大于显示尺寸：/figma/home/footer/qr-wechat.png · /product/isp-proxies（1440x900、390x844） · 原图宽 627px，显示宽 160px（3.9 倍） · `fp_744251d2c33c`
- F16 点击目标过小 48×21：产品 · /product/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_d960703a8ed6`
- F17 点击目标过小 76×21：使用场景 · /product/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 76×21px，低于 24px · `fp_1df706978bd9`
- F18 点击目标过小 48×21：资源 · /product/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_c98eeea3f8bc`
- F19 点击目标过小 84×19：企业测试申请 · /product/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 84×19px，低于 24px · `fp_e8ade3d43a2e`
- F20 图片分辨率远大于显示尺寸：/figma/product/hero/dc-hero-visual.png · /product/datacenter-proxies（1440x900） · 原图宽 1200px，显示宽 600px（2.0 倍） · `fp_17d2edaa065f`
- F21 图片分辨率远大于显示尺寸：/figma/home/footer/qr-wechat.png · /product/datacenter-proxies（1440x900、390x844） · 原图宽 627px，显示宽 160px（3.9 倍） · `fp_74af8eb1bd28`
- F22 点击目标过小 48×21：产品 · /pricing/isp-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_0a6bfad91eb7`
- F23 点击目标过小 76×21：使用场景 · /pricing/isp-proxies（1440x900） · 在 1440px 宽下可点区域 76×21px，低于 24px · `fp_496d11dcad04`
- F24 点击目标过小 48×21：资源 · /pricing/isp-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_adcf1892821a`
- F25 点击目标过小 20×20：目标业务用途说明 · /pricing/isp-proxies（1440x900） · 在 1440px 宽下可点区域 20×20px，低于 24px · `fp_8b35f5a4a5c1`
- F26 图片分辨率远大于显示尺寸：/figma/why/isp-resource.png · /pricing/isp-proxies（1440x900、390x844） · 原图宽 838px，显示宽 419px（2.0 倍） · `fp_49185bc8f602`
- F27 图片分辨率远大于显示尺寸：/figma/home/footer/qr-wechat.png · /pricing/isp-proxies（1440x900、390x844） · 原图宽 627px，显示宽 160px（3.9 倍） · `fp_58804e9b3385`
- F28 点击目标过小 48×21：产品 · /pricing/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_a29ceffd8b5a`
- F29 点击目标过小 76×21：使用场景 · /pricing/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 76×21px，低于 24px · `fp_fec435fd1233`
- F30 点击目标过小 48×21：资源 · /pricing/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 48×21px，低于 24px · `fp_e89021e27b33`
- F31 点击目标过小 20×20：目标业务用途说明 · /pricing/datacenter-proxies（1440x900） · 在 1440px 宽下可点区域 20×20px，低于 24px · `fp_d67c82f984b1`
- F32 图片分辨率远大于显示尺寸：/figma/why/dc-speed.png · /pricing/datacenter-proxies（1440x900、390x844） · 原图宽 838px，显示宽 419px（2.0 倍） · `fp_94a53fb0f27b`
- F33 图片分辨率远大于显示尺寸：/figma/home/footer/qr-wechat.png · /pricing/datacenter-proxies（1440x900、390x844） · 原图宽 627px，显示宽 160px（3.9 倍） · `fp_9315240f9732`
- F35 点击目标过小 72×36：免费试用 · /（390x844） · 在 390px 宽下可点区域 72×36px，低于 44px · `fp_c795aea3f3a9`
- F36 点击目标过小 38×38：打开菜单 · /（390x844） · 在 390px 宽下可点区域 38×38px，低于 44px · `fp_b533432a778b`
- F37 点击目标过小 120×40：查看详情 · /（390x844） · 在 390px 宽下可点区域 120×40px，低于 44px · `fp_edf5a76d3f92`
- F38 图片分辨率远大于显示尺寸：/figma/home/footer/qr-wechat.png · /（390x844） · 原图宽 627px，显示宽 160px（3.9 倍） · `fp_268a5f68c59b`
- F39 点击目标过小 72×36：免费试用 · /product/isp-proxies（390x844） · 在 390px 宽下可点区域 72×36px，低于 44px · `fp_7046eb4fad0d`
- F40 点击目标过小 38×38：打开菜单 · /product/isp-proxies（390x844） · 在 390px 宽下可点区域 38×38px，低于 44px · `fp_0b0ca5714a91`
- F41 点击目标过小 73×40：cURL · /product/isp-proxies（390x844） · 在 390px 宽下可点区域 73×40px，低于 44px · `fp_45b98c19406f`
- F42 点击目标过小 88×40：Python · /product/isp-proxies（390x844） · 在 390px 宽下可点区域 88×40px，低于 44px · `fp_ea42750731ee`
- F43 点击目标过小 72×36：免费试用 · /product/datacenter-proxies（390x844） · 在 390px 宽下可点区域 72×36px，低于 44px · `fp_c6cf52c436e0`
- F44 点击目标过小 38×38：打开菜单 · /product/datacenter-proxies（390x844） · 在 390px 宽下可点区域 38×38px，低于 44px · `fp_cfcb2320b1fe`
- F45 点击目标过小 73×40：cURL · /product/datacenter-proxies（390x844） · 在 390px 宽下可点区域 73×40px，低于 44px · `fp_fb6a1de30610`
- F46 点击目标过小 88×40：Python · /product/datacenter-proxies（390x844） · 在 390px 宽下可点区域 88×40px，低于 44px · `fp_a060500d4c29`
- F47 点击目标过小 72×36：免费试用 · /pricing/isp-proxies（390x844） · 在 390px 宽下可点区域 72×36px，低于 44px · `fp_a48c356466fe`
- F48 点击目标过小 38×38：打开菜单 · /pricing/isp-proxies（390x844） · 在 390px 宽下可点区域 38×38px，低于 44px · `fp_940629b1f81e`
- F49 点击目标过小 70×40：3天 试用 · /pricing/isp-proxies（390x844） · 在 390px 宽下可点区域 70×40px，低于 44px · `fp_4c172f314d3d`
- F50 点击目标过小 70×40：7天 · /pricing/isp-proxies（390x844） · 在 390px 宽下可点区域 70×40px，低于 44px · `fp_b5478977d95d`
- F51 图片分辨率远大于显示尺寸：/figma/why/isp-tools.png · /pricing/isp-proxies（390x844） · 原图宽 836px，显示宽 350px（2.4 倍） · `fp_290dfb9fbe4d`
- F52 图片分辨率远大于显示尺寸：/figma/why/isp-stability.png · /pricing/isp-proxies（390x844） · 原图宽 836px，显示宽 350px（2.4 倍） · `fp_da60c83777fc`
- F53 点击目标过小 72×36：免费试用 · /pricing/datacenter-proxies（390x844） · 在 390px 宽下可点区域 72×36px，低于 44px · `fp_8f9381af761b`
- F54 点击目标过小 38×38：打开菜单 · /pricing/datacenter-proxies（390x844） · 在 390px 宽下可点区域 38×38px，低于 44px · `fp_f21c7d88a971`
- F55 点击目标过小 97×40：7天 · /pricing/datacenter-proxies（390x844） · 在 390px 宽下可点区域 97×40px，低于 44px · `fp_e6757e058319`
- F56 图片分辨率远大于显示尺寸：/figma/why/dc-sessions.png · /pricing/datacenter-proxies（390x844） · 原图宽 836px，显示宽 350px（2.4 倍） · `fp_2a1fba7f638e`
- F57 图片分辨率远大于显示尺寸：/figma/why/dc-cost.png · /pricing/datacenter-proxies（390x844） · 原图宽 836px，显示宽 350px（2.4 倍） · `fp_8c03ec703ba5`

</details>

## 覆盖范围

视口：1440x900、390x844。页面 10 次打开，检查点 0 个。

| 页面 | 视口 | 结果 | 控制台 | 4xx/5xx | 坏链/已查 | 坏图 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| / | 1440x900 | 已打开 | 0 | 0 | 0/10 | 0 |
| /product/isp-proxies | 1440x900 | 已打开 | 0 | 0 | 0/9 | 0 |
| /product/datacenter-proxies | 1440x900 | 已打开 | 0 | 0 | 0/9 | 0 |
| /pricing/isp-proxies | 1440x900 | 已打开 | 0 | 0 | 0/8 | 0 |
| /pricing/datacenter-proxies | 1440x900 | 已打开 | 0 | 0 | 0/8 | 0 |
| / | 390x844 | 已打开 | 0 | 0 | 0/0 | 0 |
| /product/isp-proxies | 390x844 | 已打开 | 0 | 0 | 0/0 | 0 |
| /product/datacenter-proxies | 390x844 | 已打开 | 0 | 0 | 0/0 | 0 |
| /pricing/isp-proxies | 390x844 | 已打开 | 0 | 0 | 0/0 | 0 |
| /pricing/datacenter-proxies | 390x844 | 已打开 | 0 | 0 | 0/0 | 0 |

## 没测到的

- 只读探测拦下了所有写请求：下单、支付、提交表单这类流程没有走到底。
- 检查点之外的业务规则（价格计算、权限、数据口径）需要按 PRD 写检查点，或由 AI 测试后用 `heimdall qa submit` 提交。
- 这次没带登录档，需要登录的页面没测。

## 怎么处理这份报告

对每条建议提单的问题，告诉 Heimdall 你的裁决，下次同样的问题会自动归类：

```
heimdall qa verdict F1 bug "确认是问题，已提单"
heimdall qa verdict F2 false-positive "脚本点击不算用户手势，真人点正常"
heimdall qa verdict F3 convention "【】是强调写法" --pattern
```
