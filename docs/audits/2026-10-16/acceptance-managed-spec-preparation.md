# 托管 Spec 派发准备验收

日期：2026-10-16。范围：B2.2-a，私有合同重建与不可变派发准备。操作合同见[指南](../../competition/acceptance-managed-spec.md)。本阶段未增加 HTTP 托管端点、执行按钮、worker、manifest 创建或中断恢复，返回 `state:'prepared'`、`runCreated:false`、`executionReady:false`。

## 实现与保护

来源完整验证内核由需求候选与托管准备共用；公开候选投影继续只返回 projection / preview。新计划只继承经原始 bytes 验证且与候选完全一致的规范合同。来源与目标版本分别保存，原 draft.approved=false 和原门禁保留，目标响应不参与 expected。

准备与目录写入共用串行队列，首次接受要求双 CAS、精确当前 selection 与摘要、同项目目标。temporary 写入完成、全部二读和历史扫描结束后，再次核验完整来源、目录原字节和 owner；随后仅保留根、目录和临时文件身份 / 元数据 fence 再发布。只把准备保存到独立版本化 sidecar，不增加 catalog entity/event/revision。

派发记录严格校验字段、身份引用、规范计划、请求与计划摘要及 scope / rule / oracle 摘要。记录有界读取且二次核对 bytes 与身份。发布前完整写入并 fsync，使用排他 hard link 发布；同键不覆盖。发布后异常保留原件并标记可能已接受；重试只读取原记录。

同键核对先于新操作的 CAS、current 和来源读取，因此取消选用、来源缺失或目录不可读不会把原操作变成新准备。只有确认不存在才允许首次接受。损坏记录保留并阻塞；历史不自动裁剪。普通 B2.1 初始化与 HTTP 流程不扫描 sidecar，也没有能调用私有准备的路由。

独立审查复现并修正两个边缘：原顺序在业务 guard 后仍二读 temporary 和扫描历史，注入来源变化时可能接受旧确认；现回归证明该变化在最后业务校验受阻，guard 到 link 前不再读取临时文件或历史派发记录正文。同步 hook 误传普通 async function / Promise.reject 时也会同步拒绝并消费原生 Promise 的拒绝；严格子进程验证没有未处理拒绝、自定义 then / constructor getter 未执行。

## 验证与证据

[证据索引](evidence/acceptance-managed-spec-preparation/README.md)保留准备原记录、源码摘要、完整专项输出与回归结果。下列数字由最终原始日志和 JSON 核对。

| 检查 | 结果 |
| --- | --- |
| 全量 core | 1377 项，1375 pass、0 fail、2 Docker skip，224099.0229 ms |
| 计划 / sidecar / 目录集成专项 | 108 / 108 pass，0 fail、0 skip |
| 加入基线 / 完整性 / 来源的扩大专项 | 208 / 208 pass，0 fail、0 skip，15805.6019 ms |
| 语法 | 346 文件通过 |
| 独立准备 smoke | 21 / 21 通过，真实 owner 释放再取得，同键 bytes 与 ID 相同 |
| 原需求基线浏览器回归 | 13 / 13 检查通过；16 次浏览器 POST，errors=[] |
| 无执行与来源保护 | 两个已归档 source run / 14 文件 SHA 不变；目标请求 0、fetch 尝试 0、新 run 0；没有预留 run 目录 |

准备 smoke 直接读取 tracked B2.1 原件和归档 SHA 索引，无历史 Git 对象依赖，可在 shallow checkout 执行。其目标 HTTP 服务实际监听，但未收到请求；测试没有启动引擎、Browser 或 executor。浏览器回归是另一条已有需求基线流程，使用真实本地夹具、worker 与 Chromium，不能把它算作托管执行验收。`acceptance:managed:prepare:smoke` 已接入根 / core package 与 CI。

原始大日志位于本机 ignored 目录 `core/workspace/_runs/acceptance-managed-preparation-*`。本机两个 Docker offline 用例仍按环境跳过，本批推送后单独跟踪对应提交的 CI；`022f345` 的绿色结果只用于其自身的上一阶段修复。

## 剩余边界

本阶段的 runId / taskId 仅预留，prepared 不表示任务已启动。记录是当前本地 owner 接受的合同与来源快照，不是对需求正确性的证明，也不是管理员不可重写的签名。

文件发布不是跨文件事务，fsync 文件不代表整个目录断电持久。故障注入只证明所列时序，不能替代真实断电验收。新 owner / 升级 / 同键重试均不得自动启动历史 prepared 记录；后续 executor 需要独立实现运行槽、取消、写盘 fence、provenance 及恢复，不能把已存 sidecar 直接交给旧 CLI 执行。
