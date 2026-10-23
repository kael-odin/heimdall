# 跨页同时启动的原子回执占位修复

记录时间：2026-10-18（Asia/Hong_Kong）；目录日期沿用协调者既有命名。仅变更 helper、Vue 组件及对应两个纯 Node 专项文件，没有启动 Browser/Core，也没有提交或推送。

修前确定性反例使用真实 Vue 脚本及两个独立状态、真实 helper、共享内存 storage 和 FIFO serialized lock。先占锁，让两页都从空集合进入 start 并排队，再放锁，得到两个 POST 与两条回执。请求运输仅注入受控 503，未访问 HTTP/Browser。原件见 `cross-page-start-race-result.json` 与脚本；修前四文件及 SHA 见 `before/`、`before-sha256.json`。

根因是通用 `save` 正确保留集合，但不能保证“开始一次新的验收时集合为空”。Vue 的空集合预检发生在异步等锁之前，两页均可越过该检查。修复保留通用 `save` / `resolveExact`，新增 `claimForStart`：在同一个 origin/project Web Lock 中重新读取集合，非空立即返回 false 且不写；空集合只保存本次唯一确认，完整回读一致后返回 true。锁封装现在保留 callback 返回值。

Vue start 只使用专用 claim。false 是正常竞争结果：当前上下文仍有效时重新读取原 pending，展示待核对提示；finally 消耗 review/确认并加载原操作。不新增回执、不 POST、不标记存储故障。throw 仍触发原按项目锁存，读回错误后即使 storage 再变空也不能继续提交。等锁时项目切换仍只对捕获的原 client 写入，旧 start 不触达运输。

`node --test core/test/acceptance-browser-start-resolution-console.test.mjs core/test/acceptance-browser-start-resolution-console-state.test.mjs` 于 UTC 2026-10-17T16:06:41.507Z–16:06:41.804Z 执行，25 tests / 25 pass / 0 fail / 0 cancelled / 0 skip，exit 0。原始输出与四文件受测前后 SHA 见 `pure-tests.stdout.txt`、`pure-tests.stderr.txt`、`pure-tests.json`；前后四文件完全一致，`git diff --check` 同样 exit 0。

新增覆盖：

- 两个 helper claim 同锁排队，返回 true/false，仅一次保存、一条回执。
- 普通 save 先于等待中的 claim 写入，claim 返回 false，不增加写入；原 save/save 集合保留测试继续存在。
- 同 operationId 的字段被存储层改写，完整回读校验仍拒绝。
- 两个实际 Vue 状态同时 start，总计仅一 POST、一条共享回执；竞争失败方可读、无 fault、review/confirmed 被清除。
- Vue 等锁期间出现原回执，零新 POST、无 fault、原回执保留。
- 空值和同 ID 改字段的错误回读均锁存，后续空读取不能解除故障。

这些测试执行实际组件脚本与 Vue refs/computed/watch，但不包含 DOM/storage-event，也不声称真实两页 Vue 浏览器闭环。随后统一 Browser smoke 和全 Core 由协调者在 round7 新冻结下重跑。此前 round6 通过属于修前源码，不能替代本次修复后的统一门禁。

最小差异与修后副本见 `fix-only.patch`、`after/`、`after-sha256.json`。
