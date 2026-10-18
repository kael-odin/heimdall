# 人工缺陷单

范围：固定关联检查。

> 菜单还原的两个固定检查

编号：dt\-f449a223\-346a\-4821\-8578\-7f36b78ae678
严重度：high
人工处理状态：closed
当前核验状态：verified\_passed
关联检查数量：2
导出时间：2026\-10\-18T03:29:06\.583Z

## 问题说明

> Compare dashboard\[query omitted\] and //example\.test/path

## 复现说明

> 打开固定页面并展开菜单，核对布局与行为。

## 固定来源

操作：bo\-88033ac0\-7783\-422e\-9bae\-ec37e2d9da35
报告 SHA256：813b0bb32e68c8e1b61d73e3ded7cef51e1ba91268856696039e7424f3a59cb8
登记 SHA256：d2a6b5fd31968c7650083764994b52686d1d7bcaea2e00d8a94023dd190896e3
成员集合 SHA256：dd792742cc266a9895fedb36a28fa9c5e470ac803298233dab8743cc143bae3e

## 关联检查与证据

- 检查：route\-1\-1\-desktop\-point\-1\-menu；路由：/；BUG：bug\-f863e6846cbc3c9f85c76a5506f186a92c65c72320093ae0d3e9ff8c67183611
  - baselineDetails：source\-route\-1\-1\-desktop\-point\-1\-baseline\.json；2019 bytes；SHA256 d0dfd5a695915236e8157707cd46f67092d218e8b782168f84c6b5fabafddf14
  - baselineRepeat：source\-route\-1\-1\-desktop\-point\-1\-baseline\-repeat\.png；20801 bytes；SHA256 fad70f008284c23961c1f598183376a691918a323818a7351c4d6876f5bb8fe0
  - baselineScreenshot：source\-route\-1\-1\-desktop\-point\-1\-baseline\.png；20801 bytes；SHA256 fad70f008284c23961c1f598183376a691918a323818a7351c4d6876f5bb8fe0
  - targetDetails：route\-1\-1\-desktop\-point\-1\-target\.json；1976 bytes；SHA256 f0ed67881ac76f11bbca2edffb4dd1d327d4385faa5bc98eb5b4deeec4bc9875
  - targetRepeat：route\-1\-1\-desktop\-point\-1\-target\-repeat\.png；19446 bytes；SHA256 1225aed12b39a898e611acfdbfeaec641f39d32f6257aef2c70e1b3d3e045885
  - targetScreenshot：route\-1\-1\-desktop\-point\-1\-target\.png；19446 bytes；SHA256 1225aed12b39a898e611acfdbfeaec641f39d32f6257aef2c70e1b3d3e045885
- 检查：route\-1\-1\-desktop\-visual；路由：/；BUG：bug\-d897ffe3baaf1672f5ecf6d36134211753ab14af7201c8aace39dc1d2dbf49e4
  - baselineDetails：source\-route\-1\-1\-desktop\-baseline\.json；1499 bytes；SHA256 9a4f46886e80502a07c742bb32fa3da3a7745d8a41bffd26cb79a1823195436a
  - baselineRepeat：source\-route\-1\-1\-desktop\-baseline\-repeat\.png；18603 bytes；SHA256 202d38f7589893b5087810ec44d54397af3d1dd83e82b7a9146a262672ee49d1
  - baselineScreenshot：source\-route\-1\-1\-desktop\-baseline\.png；18603 bytes；SHA256 202d38f7589893b5087810ec44d54397af3d1dd83e82b7a9146a262672ee49d1
  - diff：route\-1\-1\-desktop\-diff\.png；18902 bytes；SHA256 fcfb328862c42286b58454bd70838b284574f859872e2a0e61244ac4117fa8e3
  - targetDetails：route\-1\-1\-desktop\-target\.json；1451 bytes；SHA256 bbbe4247184d619ea07e21eb34c5fddab57a983309a4067f3dc03276abb8e6f9
  - targetRepeat：route\-1\-1\-desktop\-target\-repeat\.png；18689 bytes；SHA256 66bf1a1be26da389544bda3856aa681eb947d889eb2099e52aaeb54412f4c832
  - targetScreenshot：route\-1\-1\-desktop\-target\.png；18689 bytes；SHA256 66bf1a1be26da389544bda3856aa681eb947d889eb2099e52aaeb54412f4c832

## 当前逐项核验

- route\-1\-1\-desktop\-point\-1\-menu：verified\_passed（REGISTERED\_RELIABLE\_PASS）
- route\-1\-1\-desktop\-visual：verified\_passed（REGISTERED\_RELIABLE\_PASS）

## 人工处理历史

- revision 0 · create · 2026\-10\-18T03:21:05\.015Z · da\-aee35738\-1376\-4dd1\-a57e\-79ae9926034f · SHA256 809038246fe75370eac48af1264fc2317bda3b56917042708463f9826f168c1d
- revision 1 · close · 2026\-10\-18T03:23:05\.761Z · da\-28dc819e\-0139\-432d\-be16\-ef676788445c · SHA256 0cc4860e61421714c45464c7ec79793ac94be86f1a58b56290c6b4145f406b31

> 两项固定检查均已在当前登记中通过。

- revision 2 · close · 2026\-10\-18T03:27:45\.329Z · da\-85d40fcc\-15ea\-45d0\-8d4d\-7816cc96db92 · SHA256 8efd8913a5adc7ca4e9b6afdfb742a6f68930994308b9e445402c496a2e9c34b

> 两项固定检查均已在当前登记中通过。


## 范围限制

- 仅覆盖此人工缺陷单固定关联的检查；不代表整个页面、项目或业务流程已修复。
- 人工处理状态与当前核验状态分开；历史关闭不代替当前证据核验。
- 导出省略 URL 查询参数及已识别的敏感字段，不包含原始报告、截图、网络记录或 AI 原文。
- 无法保证识别任意人工输入的秘密；共享前仍应检查人工文字。
