# 元素定位

1 个可靠失败中，1 个定位到源码位置，0 个定位到元素或请求。

## 菜单展开但 aria-expanded 未更新

检查 `route-1-1-mobile-point-1-truth-menu-state` · behavior · /menu-state · mobile

- 断言 attribute #menu-toggle [aria-expanded] 期望「true」，目标为「false」；操作前两侧状态一致，差异由「click #menu-toggle」触发的事件处理逻辑产生；目标处理函数缺少 this.setAttribute('aria-expanded',String(!menu.hidden));
  - 目标：`/target/menu-state:15:123` `…ggle').addEventListener('click',function(){const menu=document.getElementById('menu');menu.hidden=!menu.hidden;});</script></body></html>`
  - 基线：`/baseline/menu-state:15:123` `…ggle').addEventListener('click',function(){const menu=document.getElementById('menu');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hi…`

> 定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。
