# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 标题、主标题与关键控件语义

检查 `route-1-1-desktop-structure` · structure · /title-change · desktop

- 页面标题 「Heimdall 验收演示」 → 「Heimdall 验收演示 · 新版」
  - 目标：`/target/title-change:1:161` `…scale=1"><link rel="icon" href="data:,"><title>Heimdall 验收演示 · 新版</title><style>`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
