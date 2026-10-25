# 夹具 F1：静态营销页

Heimdall-Bench 的第一个夹具（[PRD 09 §1.2](../../../../../docs/prd/ai-native/09-quality-metrics.md)、E14-13），也是重建环的示例站与 CI 底座。

| 项 | 内容 |
| --- | --- |
| 原型 | 静态营销页：页头、首屏、特性网格、用户评价、行动号召、页脚 |
| 测什么 | 三视口版面（375 / 768 / 1440，断点 640 / 1023）；本地网页字体加载；图片资产本地化；断点处理 |
| 资源 | 本地 woff2（Source Code Pro 400 / 700，SIL OFL 1.1，许可证见 `public/fonts/OFL-LICENSE.txt`）、一张 SVG、两张由代码确定性生成的 PNG |
| 依赖 | 只用 `pngjs`；完全离线 |

## 运行

```bash
node test/fixtures/bench/f1/server.mjs --port 9101
```

带缺陷启动（整站固定注入一个用例）：

```bash
node test/fixtures/bench/f1/server.mjs --port 9102 --inject f1-shift-hero-art
```

也可以按请求注入：`http://127.0.0.1:9101/?inject=f1-color-cta-band`。

## 真值

`truth/cases.json` 列出 18 个注入用例（覆盖 shift、size、color、font、spacing、image-missing、missing-content、overflow），每个带选择器、注入方式与期望值。**只给评分器读**：运行代理做重建时不要把 `truth/` 交给代理。

在代码里用：

```js
import { startFixture, CASES } from './test/fixtures/bench/f1/server.mjs';
const f = await startFixture();          // f.url → http://127.0.0.1:<随机端口>/
await f.close();
```
