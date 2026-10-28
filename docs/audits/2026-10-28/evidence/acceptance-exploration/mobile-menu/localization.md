# 元素定位

2 个可靠失败中，2 个定位到源码位置，0 个定位到元素或请求。

## 标题、主标题与关键控件语义

检查 `route-1-1-mobile-structure` · structure · /mobile-menu · mobile

- #menu-toggle 在目标页面不可见：元素自身的 display 为 none，来自规则 @media (max-width: 600px) #menu-toggle
  - 目标：`/target/mobile-menu:11:38` `@media(max-width:600px){#menu-toggle{display:none}}`

## 移动端菜单按钮缺失

检查 `route-1-1-mobile-point-1-truth-mobile-menu` · behavior · /mobile-menu · mobile

- 断言 visible #menu-toggle 期望「成立」，目标为「false」；#menu-toggle 在目标页面不可见：元素自身的 display 为 none，来自规则 @media (max-width: 600px) #menu-toggle
  - 目标：`/target/mobile-menu:11:38` `@media(max-width:600px){#menu-toggle{display:none}}`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
