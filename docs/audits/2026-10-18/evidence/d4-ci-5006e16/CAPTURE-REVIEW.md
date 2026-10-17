# D4 CI采集与解析复核

`capture.py` 是最初观察所用脚本，保留原字节。后续观察和最终捕获使用新增 `capture-v2.py`，避免改写原观察的脚本依据。v2以显式异常检查精确仓库、run、head、attempt、workflow、push/main和唯一三job；记录实际Python运行参数及脚本SHA；保留失败/超时/启动异常的命令原件；安全校验ZIP路径、CRC及资源界限，展开后反读实盘字节；workflow API与精确git show按原字节和Git blob SHA核对。

`verify-ci.py` 单独重读原件和命令记录，核对固定输出文件名、长度、SHA、capture运行参数、ZIP每成员及实际实盘文件；执行验收只有在原件完整、身份匹配和执行检查均通过时才成立。它核对3job、所有步骤、19项后续smoke、独立主Core统计和4项Linux预期skip、D3 16checks、D4 9checks、显式Docker两用例和独立smoke job四项。聚合job日志不重复计数。

ZIP逐步骤日志和gh完整stdout分别保留原件与SHA。交叉比较先去除两者的时间戳/BOM/终端颜色码：gh会将部分实际ANSI控制码显示成可打印的 `^[[...`，两种表示都会规范化。此处理只用于派生比较，不修改原始日志。

独立子代理对v2采集器和解析器做了只读审查。初审指出的assert优化失效、原件文件名绑定、capture摘要身份、执行结论依赖关系等缺口已经在ignored脚本内修正。`calibrate-parser.py`只读保留D3原件校准34个步骤的gh/ZIP交叉比较，结果另建时间戳目录。这是解析校准，不能替代当前D4精确提交的最终结果。
