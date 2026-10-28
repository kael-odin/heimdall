# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 标题、主标题与关键控件语义

检查 `route-1-1-desktop-structure` · structure · /aria-label-change · desktop

- #menu-toggle 的可访问名称 「菜单」 → 「主菜单」
  - 目标：`/target/aria-label-change:12:84` `…><button id="menu-toggle" type="button" aria-label="主菜单" aria-expanded="false" aria-controls="menu">菜单</button></header>`
  - 基线：`/baseline/aria-label-change:12:84` `…><button id="menu-toggle" type="button" aria-label="菜单" aria-expanded="false" aria-controls="menu">菜单</button></header>`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
