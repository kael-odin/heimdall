# D6 决策合同与 Catalog 修复独立只读审查

基线为 `41c359a62ecbb67ac15f38c51c95fa983a7492d3`；审查对象是 `codex/defect-ticket-decisions-d6` 工作树当前未提交文件，精确字节 SHA 见 `reviewed-inputs.json`。结论为：**在本次已审范围内未发现新的阻塞问题**。这不是整轮发布验收结论。

本代理仅阅读源码、差异、测试与其他代理保存的原输出。未运行专项、Browser、engine 或重型 Core，未修改维护实现或测试。工作树祖先可用的 `C:/Users/44548/.codex/AGENTS.md` 为空；仓库内未发现额外 AGENTS/CLAUDE 指引。

## D6 已核对合同

|关注项|代码位置|结论与覆盖边界|
|---|---|---|
|旧确认 proof-first|store 247–253、330；service 156–199、183–188|admission 在 queue 容量前读取既有决定，execute 再读取一次；既有完整 proof 不调用新决定 ready/catalog/source prepare。action 读仅在未命中时读取当前项目。读取仍需要真实 owner 和完整命名空间校验。|
|同物理 action 唯一胜者|store 265–314|event 与 rejection 共用 queue、同 `events/actionId.json`，linkSync 独占发布而不覆盖。第二个调用返回第一份相同 fingerprint 的完整原件；不同请求或项目不能重用动作号。|
|新决定同步 ready/owner/发布 guard|service 31–53、159–199；store 271–313|ready guard 禁异步函数/Promise结果，允许 true/undefined，false等不能出版；prepare、staged及发布前后重新核验。已尝试publication后的异常保留unknown，不推断撤回。deny不读取目标站点或旧来源来构造拒绝原件。|
|HTTP recovery exception|engine 1274–1281；API 74–121|仅完整精确 `POST actions/da-UUID/deny` 可越过 recovery 写门禁，随后service只允许完整既有决定或新决定ready；认证和owner仍在之前执行。原create/close在recovery阻塞时503是新增engine测试明确的设计，不误报为proof-first缺陷。|
|严格拒绝 proof|schema 124–173；frontend helper 233–274|完整原确认、路径scope、请求fingerprint、请求规范顺序、拒绝kind/effect/actor/time、canonical JSON+LF SHA逐项校验；unknown字段/混合decision版本不接受。私有proofBindings仅授予经过完整核验的对象。|
|Web Lock 与ABA|frontend helper 321–327；Vue 72–76、183–232、246–269|resolveExact进入排他锁后再次要求current严格true；exactPending绑定project/client/guard/pendingEpoch/完整集合，project A-B-A与storage事件失效旧异步结果。拿锁后不直接按action号盲删。|
|拒绝与业务投影隔离|store 204–233；service receipt143–155；Vue showDecision|拒绝进入全namespace完整性/容量计数，但不进入accepted ticket chain，不把拒绝显示为成单或关闭，不打开原本不存在的ticket。recorded-first结果保留原事件，不被永久拒绝撤销。|

静态阅读的专项包括：create/close两种完整确认、event/rejection竞争两种顺序、零或满queue既有proof、损坏当前catalog/source下既有proof、新决定ready失效/owner丢失、发布前与发布后异常不确定性、拒绝字段/摘要重算攻击、五个await边界的project ABA、Web Lock等待期间storage ABA，以及12个独立被杀进程现场测试。这里只确认测试设计和实现相符；未将未执行的测试当作本代理运行通过。

未找到能够在当前合同内给出的新增可复现阻塞反例。整namespace读取不是多文件原子快照，也不覆盖回滚、owner以外的外部篡改者或整机断电exactly-once；不能把静态审查扩大为这些保证。

## Catalog 最终四文件

- `acceptance-catalog.js` 增加60000ms单预算，覆盖fetch和完整response.json。Promise.race使不遵循AbortSignal的底层promise也能结束调用；race后及调用json前再次检查abort。取消流不await，避免清理重新延长deadline；计时器和外部listener在finally清理。
- GET主动项目切换abort继续返回AbortError；deadline为REQUEST_TIMEOUT。已尝试POST的超时或abort均保留writeMayHaveCommitted；不完整400/409/503正文不能只凭status认定确定拒绝。没有自动POST重发。
- Vue的已核验写ACK提前到refresh之前显示；mutate、baseline、binding在refresh await返回后先检查stopped。实际Vue回归覆盖mutate(project/release)与read lifecycle，baseline/binding/candidate的ACK位置仅做静态复核，不能称四路均实测。
- 原catalog Browser smoke的Git对象hash保持 `8ccb392637be90880a0770e4dd61613dd758c778`，旧断言和25000ms等待未改；本代理没有执行该smoke。

原输出读回：helper-final为24 tests / 24 pass / 0 fail / 0 skip；state-final为16 / 16 / 0 / 0，两份stderr空、result exit0。`after-results.json`的两输入SHA与当前helper/Vue逐字节匹配，fetch/body受控stall均显示ACK立即可见、REQUEST_TIMEOUT后busy释放，手工GET恢复且POST始终一次。证据等级是离线actual Vue refs/watchers，不能替代Browser运行或说明原CI具体根因。

UI detector exit2仅报原有catalog-boundary的2px单边强调线，当前CSS未改。保留warning，不把detector写成清零通过。

## 收尾边界

当前 `docs/competition/acceptance-defect-tickets.md` 仍是D5文档，包含“尚未提供永久拒绝”、仅recorded解除、HTTP缺deny行等旧描述。已通知根代理作为D6最终文档同步项，本代理未改文档。新的D6 Browser与进程实验以及最终完整Core/精确提交CI由主任务统一调度。

先前 run `39082419484 / attempt1 / 41c359...` 保持failure；本次deadline产品修复与离线模型通过不能改写原CI结论，也未确定原CI卡在headers还是JSON。原件另见旧D5树的 `ci-catalog-failure-20261018/REPORT.md`。
