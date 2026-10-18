# D6 专项审查与早期运行原件

此目录归档已经结束的专项输出、静态审查和早期失败元数据，保留源目录。`source-file-digests.json` 逐项列源路径、目标路径、bytes、SHA256、复制前后 stat、源原字节复读与目标读回结果；原件不改写。局部 `* -text` 保持换行，日志 `-diff`，`.gitignore` 仅为本目录原日志/摘要解除忽略。

|原目录|本次保存范围与证据等级|
|---|---|
|`d6-console-20261018`|全部19份实际原件。helper原输出35/35、Vue状态原输出23/23，各自result exit0；含4个前端/测试输入SHA。readiness审查的最初getter/unhandled问题与after输出、UI detector最初warning和最终`[]`同时保留。这些是离线Node/Vue与静态detector证据；没有保存一份完整源码快照，不能单凭SHA重构被测源码，也不等同新Browser验收。|
|`d6-contract-independent-review-20261018`|报告与当时reviewed-inputs清单，证据为只读静态审查。报告提及catalog helper24/state16等来自此前专项的二次读回；那些原日志不在本目录，不扩大为本目录独立执行。报告中的文档待同步等均为当时状态。|
|`d6-ci-wiring-independent-review-20261018`|全部4份原件，包含初版单OUT路径报告、原输入清单、新版双路径报告和artifact-dist-update。它们保留前后变化，属于静态接线复核；没有下载或验收新版真实CI ZIP。|
|`d6-implementation-20261018`|只保存8份顶层脚本/旧八文件摘要/早期日志、1次已结束service专项的5份run/inputs/log、早期engine各case直属HTTP/source摘要与stdout/stderr。该engine顶层输出为7/7，但没有完整命令生命周期metadata或完整实现源码快照；不将它升级为当前冻结输入整轮通过。|

早期失败原件完整保留：顶层`service-api-20261018-083807857.stdout.log`包含proof ORIGINAL_PATH_MISMATCH和15秒fixture超时；`service-d6-20261018T005114.056019Z/run.json`为exit1，原输出8项/7 pass/1 fail，close/recorded为`fixture delayed body timeout`，且其输入清单记录两份runner/relay文件在运行期间改变。这里不改写历史失败，也不推断当前最终Core的根因。顶层`run-final-batch.py`等脚本只证明当时执行来源，单独保存脚本不证明它已经成功执行。

所有`final-*`目录及活动Core整目录排除，未枚举、复制或修改其中内容；完整runtime、数据库、来源图片与Browser目录也排除。本归档仅承诺manifest明列文件的复制完整性，不承诺其未归档子树完整或当前源码一致。排除目录逐项见manifest的`selection.excluded`，不稳定源若存在则另列`excludedUnstableFiles`。维护源码、CI、生产UI和测试断言未被此次归档修改；没有新运行Browser、engine、测试、build或CI，没有stage/commit。

原始日期均为2026-10-18，路径中的数字是来源标识；后续主任务的正式Browser、最终Core及精确提交CI应分别按其原始证据判断。
