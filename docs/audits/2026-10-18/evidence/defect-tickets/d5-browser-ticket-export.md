# 人工缺陷单

范围：固定关联检查。

> 菜单还原的两个固定检查

编号：dt\-6d59c7d3\-d29b\-459a\-a63f\-dfe7342b73a9
严重度：high
人工处理状态：closed
当前核验状态：verified\_passed
关联检查数量：2
导出时间：2026\-10\-17T20:31:44\.719Z

## 问题说明

> Compare dashboard\[query omitted\] and //example\.test/path

## 复现说明

> 打开固定页面并展开菜单，核对布局与行为。

## 固定来源

操作：bo\-92fa1020\-2982\-4a51\-a279\-0cff8b7b9b6f
报告 SHA256：a50f01f78cba6c79c9ef02d56cd1b2bc08d2c624ef652a473de343b0d3fa6b9b
登记 SHA256：4679f1f98ab1d9a834b69c1fbfbe5a71f1cc272de3d042a00c716adba81d7a4a
成员集合 SHA256：1e6213da5ceb64f090fd80530d2c680711b0b4cfc1e94ff61c41a70a53cbfd13

## 关联检查与证据

- 检查：route\-1\-1\-desktop\-point\-1\-menu；路由：/；BUG：bug\-f85f70ea2bb43a8fadce781a3f7b8d8d01b8c7bab7de8d3df35f20e5ae4f4014
  - baselineDetails：source\-route\-1\-1\-desktop\-point\-1\-baseline\.json；2019 bytes；SHA256 2a4fb7298b8a32b5310e649af7f496660b83da559cc5e6b16cb542bed72fb60a
  - baselineRepeat：source\-route\-1\-1\-desktop\-point\-1\-baseline\-repeat\.png；20801 bytes；SHA256 fad70f008284c23961c1f598183376a691918a323818a7351c4d6876f5bb8fe0
  - baselineScreenshot：source\-route\-1\-1\-desktop\-point\-1\-baseline\.png；20801 bytes；SHA256 fad70f008284c23961c1f598183376a691918a323818a7351c4d6876f5bb8fe0
  - targetDetails：route\-1\-1\-desktop\-point\-1\-target\.json；1976 bytes；SHA256 76fdc270dcb39de27a2c85d849050ca06355bb208062c654ee5df1cc3517ef7d
  - targetRepeat：route\-1\-1\-desktop\-point\-1\-target\-repeat\.png；19446 bytes；SHA256 1225aed12b39a898e611acfdbfeaec641f39d32f6257aef2c70e1b3d3e045885
  - targetScreenshot：route\-1\-1\-desktop\-point\-1\-target\.png；19446 bytes；SHA256 1225aed12b39a898e611acfdbfeaec641f39d32f6257aef2c70e1b3d3e045885
- 检查：route\-1\-1\-desktop\-visual；路由：/；BUG：bug\-8c4e5c8f38dfe942ee83dddea77300301c6390603c1ce039004bafc739497694
  - baselineDetails：source\-route\-1\-1\-desktop\-baseline\.json；1499 bytes；SHA256 32b1bc8507ecd1c1b2dbd31e0af1c738a798130f8dfceb83e3aeab24cf71ec16
  - baselineRepeat：source\-route\-1\-1\-desktop\-baseline\-repeat\.png；18603 bytes；SHA256 202d38f7589893b5087810ec44d54397af3d1dd83e82b7a9146a262672ee49d1
  - baselineScreenshot：source\-route\-1\-1\-desktop\-baseline\.png；18603 bytes；SHA256 202d38f7589893b5087810ec44d54397af3d1dd83e82b7a9146a262672ee49d1
  - diff：route\-1\-1\-desktop\-diff\.png；18902 bytes；SHA256 fcfb328862c42286b58454bd70838b284574f859872e2a0e61244ac4117fa8e3
  - targetDetails：route\-1\-1\-desktop\-target\.json；1451 bytes；SHA256 cedc990e5715688bed914ebf1e8d52353b7ce10bd129f39c2c46649b9956d1fe
  - targetRepeat：route\-1\-1\-desktop\-target\-repeat\.png；18689 bytes；SHA256 66bf1a1be26da389544bda3856aa681eb947d889eb2099e52aaeb54412f4c832
  - targetScreenshot：route\-1\-1\-desktop\-target\.png；18689 bytes；SHA256 66bf1a1be26da389544bda3856aa681eb947d889eb2099e52aaeb54412f4c832

## 当前逐项核验

- route\-1\-1\-desktop\-point\-1\-menu：verified\_passed（REGISTERED\_RELIABLE\_PASS）
- route\-1\-1\-desktop\-visual：verified\_passed（REGISTERED\_RELIABLE\_PASS）

## 人工处理历史

- revision 0 · create · 2026\-10\-17T20:23:55\.012Z · da\-f3643b3e\-31a1\-4cf0\-bea8\-fc0dba301d84 · SHA256 b749f6332b9b2a22f266f73ee14bab56a275f5f9d55dc39f4c71e33797e58cdb
- revision 1 · close · 2026\-10\-17T20:25:52\.357Z · da\-00e4299a\-5dfe\-4636\-aaaa\-5ceb6cf8381d · SHA256 a3411e3220b8a9173edf9e5678b171b135df395d5282c874c6e930f0a62a3e05

> 两项固定检查均已在当前登记中通过。

- revision 2 · close · 2026\-10\-17T20:30:25\.761Z · da\-26d2b5d1\-f172\-44f3\-8fde\-a282968c2cd2 · SHA256 433ce91786e7318e3a8ab4b051e1fbf9bbc61f09b259ce64da2fb78e6f69bc6c

> 两项固定检查均已在当前登记中通过。


## 范围限制

- 仅覆盖此人工缺陷单固定关联的检查；不代表整个页面、项目或业务流程已修复。
- 人工处理状态与当前核验状态分开；历史关闭不代替当前证据核验。
- 导出省略 URL 查询参数及已识别的敏感字段，不包含原始报告、截图、网络记录或 AI 原文。
- 无法保证识别任意人工输入的秘密；共享前仍应检查人工文字。
