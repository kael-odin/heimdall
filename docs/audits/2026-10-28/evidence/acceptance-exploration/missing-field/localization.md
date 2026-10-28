# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 套餐配额文字字段缺失

检查 `route-1-1-desktop-point-1-truth-missing-field` · behavior · /missing-field · desktop

- 断言 text #quota 期望「包含 128 个任务」，目标为无；目标页面不存在 #quota；基线中它位于 div.metric 之后
  - 目标：`/target/missing-field:14:55` `…="panel"><span class="badge">运行正常</span><div class="metric">128</div><a id="details-link" class="cta" href="details">查看详情</a></section>`
  - 基线：`/baseline/missing-field:14:84` `…运行正常</span><div class="metric">128</div><p id="quota" class="quota">剩余配额：128 个任务</p><a id="details-link" class="cta" href="details">查看详情</a></section>`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
