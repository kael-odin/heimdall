# 无参照物检测与交互探索的固定注入基准

这套基准回答一个问题：**没有参照站时，检测器能发现多少注入的问题、误报多少、花多久。**
口径与赛题一致——检出率、误报率、耗时；统计单位是案例，一个页面命中多个检测器仍按案例计。

**证据等级是离线复现。固定夹具不是真实站点验收，这里的数字不能描述为任意项目的检出率。**

## 一键运行

```bash
node core/scripts/benchmark-qa.mjs
# 或指定输出目录
node core/scripts/benchmark-qa.mjs core/workspace/_runs/my-qa-benchmark
```

脚本自启只绑定 `127.0.0.1` 的随机端口服务器，跑完即关。每次结果写入独立时间戳目录（默认 `core/workspace/_runs/qa-benchmark/`）。`latest.json` 在运行中为 `running`、异常未完成为 `incomplete`、完成后为 `complete`；前两种状态的 `passed` 是 `null`，不能沿用上一次的通过结论。进程被强制结束后可能停留在 `running`，这同样不是通过。有漏检、误报或运行异常时退出码为 `1`。

同一个输出目录暂不支持并行运行；同时运行多份时，请为每份指定不同的输出目录，否则 `latest.json` 可能互相覆盖。

## 固定真值

夹具在 `core/test/fixtures/qa-defect-site.mjs`，基准把真值复制成输出目录里的 `truth.json`；检测器本身不读真值。

| 案例 | 注入情况 | 期望 |
| --- | --- | --- |
| `image-alt` | 图片没有 `alt` | `a11y-image-alt` |
| `control-name` | 图标按钮没有可访问名 | `a11y-control-name` |
| `form-label` | 输入框没有标签 | `a11y-form-label` |
| `duplicate-id` | 两个元素同 `id` | `a11y-duplicate-id` |
| `heading` | 页面没有 `h1` | `a11y-heading` |
| `lang` | `<html>` 没有 `lang` | `a11y-lang` |
| `iframe-title` | `iframe` 没有 `title` | `a11y-iframe-title` |
| `text-clipped` | 长文本被容器裁掉大半 | `layout-text-clipped` |
| `image-ratio` | 64×64 图片显示成 256×64 | `layout-image-ratio` |
| `tap-target` | 12×12 的按钮 | `layout-tap-target` |
| `placeholder` | 可见 `TODO:` 文案 | `content-placeholder` |
| `template` | 可见 `{{userName}}` | `content-template` |
| `mojibake` | `cafÃ© au lait` | `content-mojibake` |
| `invalid-value` | `Invalid Date` | `content-invalid-value` |
| `blank-target` | `target="_blank"` 无 `rel` | `security-blank-target` |
| `secret` | 页面 HTML 里有 `sk-` 密钥 | `security-secret` |
| `oversized-image` | 800px 图显示成 100px | `perf-oversized-image` |
| `layout-shift` | 加载后插入 480px 横幅 | `perf-cls` |
| `noop-click` | 按钮点击后无任何变化 | `interaction`（显式开启探索） |
| `throw-click` | 按钮点击后抛异常 | `interaction` |
| `gone-click` | 链接指向 404 | `interaction` |

健康分母：`clean`（每一项都合规的页面）与 `warn`（只输出 `console.warn`），任何检测发现都算误报；交互段另有 `works-click`（点击正常显示内容）作为误报对照。

自结果格式 `schemaVersion: 2` 起，静态缺陷必须同时匹配预设检测器、类别与目标；“没有 h1”还必须匹配问题语义。交互缺陷还要匹配问题类型及相应证据，例如预期异常或指定路径的 404。夹具单独记录四个按钮或链接的点击；控件数、点击数、跳过情况、预算和独立记录不一致时，停止统计。无反应案例需要完整的前后快照，不能把快照读取失败当作无反应。

`perf-cls` 是页面级指标，本基准只验证页面出现 CLS 报警，不能证明由夹具横幅造成。`security-secret` 按页面内的密钥类型匹配，不定位到指定 DOM 元素。旧版结果只按检测器或目标匹配，不应与新版结果当作同一种口径直接比较；旧结果不会自动改写。

`mixed-content` 与 `insecure-form` 只在 https 页面触发，离线 http 夹具无法覆盖，所以**不在**本基准的缺陷分母里；这两项只有代码级单测与真实站点人工复核。

## 指标

- **Recall** = 检出的缺陷案例 / 缺陷案例总数；
- **案例级 Precision** = TP / (TP + FP)，FP 是出现报警的健康案例数，不是健康页的报警条数；
- **误报率** = FP / 健康案例数；
- **耗时**：缺陷页、健康页和交互页各一次运行的墙钟时间，合并后取 P50 / P95；样本只有 4 次，不是稳定的性能评估。

`benchmark.md` 按案例列出预期检测器、是否检出、命中证据（选择器与实测值）和失败原因。`benchmark.json` 的 `unmatchedDefectFindings` 和 `unmatchedInteractionFindings` 保留未匹配缺陷真值的其他报警；它们需要另行复核。健康案例以外的报警不进入健康案例 FP，因此案例级 Precision 不是所有报警的准确率。

## 最近一次结果

先看输出目录里的 `latest.json` 是否为 `complete`，再查看该次目录的 `benchmark.md` 和 `benchmark.json`；不在此处抄写会变化的数字。

## 范围与边界

- 检测器是启发式的：动态水印、虚拟滚动、第三方组件都可能造成误报；报告给出 `target` 与 `observed`，由人裁决，`qa verdict ... --pattern` 可把一类误报记成规则。
- 交互探索只覆盖单步点击、只点声明页面里的有限控件；输入后才会变化的状态、多步流程、写操作之后的链路都不在结论内。
- 夹具是手写 HTML，服务端行号与文件一致；打包项目的源码定位不在此列。
- 真实项目的检出率与误报还需要用获授权的测试项目单独测量，不能把本基准的数字外推。
