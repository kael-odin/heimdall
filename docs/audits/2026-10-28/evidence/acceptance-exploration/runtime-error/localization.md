# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 浏览器脚本与控制台错误

检查 `route-1-1-desktop-console` · health · /runtime-error · desktop

- 目标页面脚本抛出异常「fixture: approved runtime script failed」，位于 /target/runtime-error:15:275
  - 目标：`/target/runtime-error:15:275` `…!menu.hidden));});setTimeout(()=>{throw new Error('fixture: approved runtime script failed')},20);</script></body></html>`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
