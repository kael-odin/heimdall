# round7 最终 Browser 启动决定恢复独立审查

日期：2026-10-18（Asia/Hong_Kong）。**最终 `browser-resolution-ui` 的机器回读与四图实际审查均通过。** 本结论只对应该最终门禁；没有将预检、其他串行阶段或尚未形成的最终提交/CI结果合并为全发布结论。本次独立复核仅运行原件读取校验及打开已存在图片，没有启动Browser/Core/引擎、修改冻结源码或提交推送。

最终新root：`core/workspace/_runs/browser-resolution-console-smoke-177bb267-39ed-4123-bc5f-a07c91fd69c2`。独立入口从最终外层stdout的唯一passed记录取得该root，核验正确label/exit/unchanged与时间范围，并拒绝预检root。

外层最终guard：UTC 2026-10-17T16:31:57.712Z–16:32:57.549Z，香港2026-10-18 00:31:57.712–00:32:57.549，exit0、unchanged true、600 files。内层smoke：UTC16:31:58.144–16:32:52.405，summary passed、checks9/9。独立原件验证exit0；四图随后实际打开，未沿用预检截图。

## 冻结与原件身份

最终before/after与round7 snapshot的600项逐项一致，当前600文件字节和SHA在机器回读及实际看图后分别核验通过。冻结快照SHA为 `f700d54a3bb10a55748818d68b6d33fe43724f8485ec72063e0a35d253c078d8`。源检查原件为`source-freeze-check.json`和`source-after-visual-check.json`；原始校验命令、stdout/stderr保留，不能用事后整理文字代替原输出。

`artifact-manifest.json`重算25份最终原件（含4张PNG及其4份DOM文本）字节和SHA；`visual-review.json`再次核对实际打开图片与该最终root的PNG身份。`machine-summary.json`保留机器完成时尚待目视的原状态；`review-summary.json`单独记录机器与目视均完成后的本阶段通过。

## A/B决定与恢复

A的原UI请求body为342bytes，prefix171，SHA `65352443a8e5c1d9d5006e35d6c1ee65c603a5f7e257b6e77cd72b975cd58fe3`。原件中的ingress与trace逐项对应：只有一个request、一条connection，前缀到达后尚未end，真实拒绝完成后才放行同一请求尾部，迟到原start返回409 `BROWSER_START_REJECTED`。路径是“原UI body经单一Node HTTP relay分段进入真实engine”，不声称Chromium socket原生拆包。

| 原操作 | 拒绝原件 | 独立重算SHA-256 |
| --- | --- | --- |
| A `bo-d12a734c-d350-4d1c-8e5e-a96875604355` | 761bytes，目录仅rejection.json，canonical JSON+单个LF | `f68534f3796edec82914749ff93c19faba6c2c75e9300cd2ed6b7d17718dcc97` |
| B `bo-89ff615a-1435-42e9-a0ba-2a9cb88a091f` | 761bytes，目录仅rejection.json，canonical JSON+单个LF | `92e4db35290be7afbdb91457e39d0e33c78e3bc43f4540c6f470fe0b53b02d39` |

proof中的原六字段、project和rejection SHA与实盘原件一致；`proof-bindings-check.json`另行逐项核对proof完整rejection等于实盘决定内容。B原start未交付，真实deny已提交后丢失一次响应；同root、origin `http://127.0.0.1:57400`、端口、BrowserContext和storage key重启后，仅3次GET恢复，没有新增POST或改写原决定。总start3、deny2，最终操作集合只含fresh完成操作。重启先SIGTERM、必要时可能SIGKILL，不能单凭该策略宣称优雅退出。

## 四组原生锁与新启动准入

实际两页导入正式helper，使用同origin/project的原生localStorage与navigator.locks。每组均有exclusive holder1、pending2和两个不同pending clientId，完整集合衔接核对通过。

| 交错 | 集合变化 | 原结果 |
| --- | --- | --- |
| save-save | 0→2 | `[null,null]`，两份完整原确认保留。 |
| resolve-save | 2→2 | `[null,null]`，解除首条，保留第二条并新增第三条。 |
| resolve-resolve | 2→0 | `[null,null]`，精确解除两条。 |
| claim-start-claim-start | 0→1 | `[true,false]`，唯一after严格等于原a确认。 |

末尾两个receipt storage key均为`[]`。此处覆盖实际helper的原生跨页锁；真实双Vue状态同时start仅1POST/1receipt另由25项纯专项覆盖，不扩大声称已完成双Vue DOM/storage-event浏览器闭环。四组是9项顶层checks内的交错，不另增加checks数。

## Fresh终态与四图实际审查

fresh为 `bo-e2312c7a-dd23-41d2-8221-4c9d9b7c755c`，与A/B不同。API completed/passed、14/14声明检查通过，recorded proof绑定原完整request。`fresh-rendered-state.json`、完整DOM和手机PNG均对应同bo，显示“已完成 · 通过”，reportButtons=1、stopButtons=0。它经过显式重新复核和新批准，没有自动重发原启动。

四张最终PNG已逐张实际打开：

- `resolution-A-desktop-light.png`：未知启动提示、原确认编号及候选/目标可见；重新复核并勾选后start灰置。内部滚动采样未覆盖原确认下部的全部动作，完整说明另有DOM。
- `resolution-B-mobile-dark.png`：未知提示与原回执上半部可读，首屏没有覆盖下部拒绝后pending说明。该说明由完整DOM原件证明，不能将DOM覆盖写成截图目视覆盖。
- `resolution-recovered-desktop-dark.png`：永久拒绝证明已核验、原确认已解除和要求重新复核的提示清楚；下方旧broken参考比较仍显示“发现缺陷”，不与随后fresh通过混同。
- `resolution-fresh-mobile-light.png`：Healthy new target、上述fresh bo、“已完成 · 通过”和完成报告按钮可见，无停止按钮。与API/DOM终态一致，不再沿用round6过早采样时running/blocked的图像结论。

桌面视口1440×1000，组件client/scroll=964/964；手机390×844，296/296，documentWidth均等于视口。没有采样横向溢出，但不构成全量无障碍认证。

| 最终图片 | bytes | SHA-256 |
| --- | ---: | --- |
| A desktop light | 156285 | `bf4d2d0c60d75c762a7f0a89670d51e6310316212576eb3534817230100b3b2b` |
| B mobile dark | 62558 | `a5aba62dbfc4b0867d05b8a74715950ef9f026d81d72277fc9d52da3bd7afd05` |
| recovered desktop dark | 149308 | `b01f09e7512fa268b5a1e055c659cba7c72fa388ebde3f081c726dc650de97f2` |
| fresh mobile light | 56863 | `42076b2d3d7f5687b5b4ad0f1d459cbf617fe139238f826804ee99f505e85ab1` |

## 其他核验与限制

29份原来源文件SHA逐项相同，source/broken/healthy请求各4，保存候选后未重新访问来源。storage/hrefs不含三类来源全文sentinel，sessionStorage为空。pageErrors为空；保留的5条console error均逐条匹配5个受控503 resource错误，没有删掉受控错误后声称零控制台错误。

独立机器结果在`independent-evidence-check.json`，源冻结结果、图片身份/目视记录、25份manifest及命令原件与本文件同目录。此次最终门禁通过与预检独立记录分开保存；其他串行门禁、最终暂存字节、实际D4提交及自身LinuxCI仍由协调者按各自原件确认。

永久拒绝保证限定于同owner对应真实数据根和保留的原决定，不覆盖人为删除、磁盘回滚、复制到另一数据根或丢失决定的备份恢复。Windows Node无portable directory fsync，此处不宣称整机掉电耐久性。受控本机站点仅覆盖声明路由/视口/交互与只读策略，不保证任意业务站点、登录态、PRD意图或Figma对照；SHA是引擎返回原事实的一致性核验，并非数字签名。
