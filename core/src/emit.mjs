/**
 * emit — 子进程向引擎上报机器可读事件的**唯一**写法。
 *
 * 引擎（engine-server.mjs 的 spawnTask）只认 stdout 里以 `@@EVENT@@` 开头的行：
 * 其余输出一律当人类日志转发给界面。所以这一行的格式、前缀、换行都是协议，
 * 出一点差错事件就静默丢失（不报错，界面只是"没有进度"）。
 *
 * 抽出来的理由：此前 12 个脚本各自复制了一份一模一样的 `emit`，其中 queue.mjs
 * 那份还悄悄多了一个"仅 --json-events 时才输出"的条件 —— 这种分叉迟早会在某次
 * 复制里丢掉一个字符，然后表现为"某个任务的进度突然没了"。一个实现，一处协议。
 */
export const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
