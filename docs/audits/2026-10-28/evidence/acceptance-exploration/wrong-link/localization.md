# 元素定位

2 个可靠失败中，2 个定位到源码位置，0 个定位到元素或请求。

## 标题、主标题与关键控件语义

检查 `route-1-1-desktop-structure` · structure · /wrong-link · desktop

- #details-link 的链接 「/details」 → 「/pricing」
  - 目标：`/target/wrong-link:14:161` `…个任务</p><a id="details-link" class="cta" href="pricing">查看详情</a></section>`
  - 基线：`/baseline/wrong-link:14:161` `…个任务</p><a id="details-link" class="cta" href="details">查看详情</a></section>`

## 查看详情跳向错误页面

检查 `route-1-1-desktop-point-1-truth-wrong-link` · behavior · /wrong-link · desktop

- 断言 url 期望「包含 /details」，目标为「http://127.0.0.1:60701/target/pricing」；#details-link 的 href 为「pricing」，基线为「details」
  - 目标：`/target/wrong-link:14:161` `…个任务</p><a id="details-link" class="cta" href="pricing">查看详情</a></section>`
  - 基线：`/baseline/wrong-link:14:161` `…个任务</p><a id="details-link" class="cta" href="details">查看详情</a></section>`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
