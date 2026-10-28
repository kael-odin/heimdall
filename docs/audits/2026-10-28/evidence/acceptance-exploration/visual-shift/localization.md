# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 页面视觉还原度

检查 `route-1-1-desktop-visual` · visual · /visual-shift · desktop

- main：transform: none → matrix(1, 0, 0, 1, 0, 160)
  - 目标：`/target/visual-shift:11:6` `main{transform:translateY(160px)}.panel{background:#8f2500;border-color:#6d1b00;color:#fff}`
- section.panel：border-color: rgb(211, 219, 234) → rgb(109, 27, 0)；background-color: rgb(255, 255, 255) → rgb(143, 37, 0)；color: rgb(23, 34, 58) → rgb(255, 255, 255)
  - 目标：`/target/visual-shift:11:60` `…slateY(160px)}.panel{background:#8f2500;border-color:#6d1b00;color:#fff}`
  - 基线：`/baseline/visual-shift:6:8` `.panel{border:1px solid #d3dbea;border-radius:12px;background:#fff;padding:28px;min-height:260px;box-shadow:0 4px 20px #17223a0…`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
