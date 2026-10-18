# Node25 本机 HTTP 空闲连接候选最小对照

结论：**本次未复现 fetch 晚请求 ECONNRESET**。fetch 和 native `agent:false` 两组均为 first 200、late 200；fetch 的 late 实际使用新连接2，未走到所怀疑的旧连接复用路径，因此不能据本次结果确认或排除原 Core 的连接复用根因。native fresh connection 对照成功，也不能独立证明产品修复或整轮验收通过。

这是父代理授权的一次独立loopback实验，没有engine、Browser、维护测试、build、目标站点或重试。未修改维护测试；实际启动的是 `C:/Program Files/nodejs/node.exe`，v25.2.1，EXE SHA256 `91ec09dda8f20556f366110859f106ab189d45f8f6a2bd092e6785174ad4a0fa`。实验2026-10-18 02:34:23.775880Z开始，02:34:38.037477Z结束，14.172秒，exit0，stderr 0 bytes。完整argv/cwd/起止/版本/文件摘要在command与stdout中。

|对照|默认服务端设置|首请求→同步工作→晚请求|连接及结果|
|---|---|---|---|
|fetch|keepAliveTimeout 5000ms，buffer 1000ms，设置未改|完整首响应后无await/yield，同进程同步工作7000.043ms，再发同正文POST|first连接1/200；late连接2/200，late约5.704ms|
|native HTTP agent:false|相同默认值|相同结构，同步工作7000.045ms|first连接1/200；late连接2/200，late约3.599ms|

四次收到的完整POST正文均为96 bytes，SHA256 `bf0df145f3edead6fcb03db80877488269b3e0e9cffd77991a1eda0f2e810e8b`，服务器逐项确认相等。两种客户端每次均新建`AbortSignal.timeout(30000)`；native设置`agent:false`且单次request。每组服务器新绑定127.0.0.1端口，事件保存请求、header、连接ID、响应、socket close/timeout、同步工作前后及server close，完整stdout保存最终完成事件。`experiment/events.jsonl`和result中的events写入于最后experiment-complete打印之前，最终完成记录以完整stdout和command终态为准。

原Core根因所需证据仍有缺口：本次没有原用例中的源文件扫描、deny与原始held提交组合、Undici历史连接池状态及当时连接ID；不能把这次最小模型的连接2结果改写为原Core也必定新连。原Core唯一失败的line381 late fetch/ECONNRESET由父代理提供，原竞争与proof已通过的结论仍应回查其最终Core原日志，本目录不复制或修改那份原件。

独立静态复核另确认：原close/rejected分支最后一次fetch为deny，其后独立httpRequest完成，再同步service.read→detail→source.capture/snapshot/assertCurrent与目录读取，late之前没有主动yield。这构成候选结构，但静态源码无法证明窗口耗时与旧连接复用。root随后新post使用单次nativeHTTP、agent:false、同30秒AbortSignal，收完整body/error/aborted/end JSON后保持status/payload返回；四案状态/proof/outcome/文件唯一性/无新Browser断言保留。没有建议提高预算或改变旧deadline。

已将本次实际执行脚本与Python启动器逐字节复制到本目录。`evidence-manifest.json`列明报告、脚本快照与原运行输出的bytes/SHA；全部源保留。本目录为ignored调查证据，尚未stage或commit。
