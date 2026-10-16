# 后端执行切片的 main CI

运行 `38977345569`，head 为 `2737c7648f46eccbcaab5cf8c69497fd22f397df`，三个 job 均 success。该提交包含 `439f629` 的真实执行实现及其后无损日志归档修正。

- [运行与步骤原始元数据](run.json)
- [完整原始日志，无损 gzip](ci.log.gz)
- [字节长度、SHA256 与解压往返校验](ci.log.gz.json)

Linux Core：1797 total、1793 pass、0 fail、4 skip。POSIX SIGTERM 实际通过；两项 Docker 在维护 suite 中跳过，随后独立 Docker 步骤 2/2 实际通过，不能再次增加到 unique suite 总数。所有既有验收 smoke、新 managed execution smoke、console build 与 local fixture smoke 均 success。

此证据只属于上述后端提交。执行 UI 后续提交需要核对自己的 head CI，不能沿用该次成功作为 UI 提交通过证明。
