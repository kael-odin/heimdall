# 元素定位

2 个可靠失败中，2 个定位到源码位置，0 个定位到元素或请求。

## 浏览器脚本与控制台错误

检查 `route-1-1-desktop-console` · health · /missing-resource · desktop

- 请求 /target/missing-widget.js 返回 HTTP 404，发起方：页面标记 /target/missing-resource:15:43
  - 目标：`/target/missing-resource:15:43` `…ooter>固定离线夹具 · 不包含真实客户数据</footer></main><script src="missing-widget.js"></script><script>document.getElementById('menu-toggle').addEventListener('click',functio…`

## 资源与只读网络请求

检查 `route-1-1-desktop-network` · health · /missing-resource · desktop

- 请求 /target/missing-widget.js 返回 HTTP 404，发起方：页面标记 /target/missing-resource:15:43
  - 目标：`/target/missing-resource:15:43` `…ooter>固定离线夹具 · 不包含真实客户数据</footer></main><script src="missing-widget.js"></script><script>document.getElementById('menu-toggle').addEventListener('click',functio…`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
