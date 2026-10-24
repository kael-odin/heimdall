/**
 * 交接说明的渲染 —— 纯函数，只吃数据，不碰磁盘。
 *
 * 单独成模块的理由：这份文字是整个交付包里唯一"承诺这个包证明了什么"的地方，
 * 比任何分数都更该被测试钉住；而 handoff.mjs 是 CLI，导入即执行，测不了。
 *
 * 写作原则：**先说没做到的**。一个写着"120 页里测到 96 页、24 页没结论"的包，
 * 比一个假装全绿的包有用；把没测到的地方藏起来，等于让人拿错结论去开工。
 */

const pct = value => typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '—';

export function renderHandoff({ siteId, origin, target, summary, gaps, delivered, skippedVerify = false, maxPages }) {
  const lines = [];
  const blockers = Object.entries(summary?.blockers ?? {}).sort((a, b) => b[1] - a[1]);
  lines.push(`# 交接说明 · ${siteId}`, '');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`源站：${origin ?? target ?? '未知'}`, '');

  lines.push('## 先说清楚覆盖到哪一步', '');
  if (skippedVerify) {
    lines.push('> **这次没有跑验证（--skip-verify）。** 下面没有任何还原度数字 ——');
    lines.push('> 复刻件是有的，但"像不像"没有测量结论。');
  } else if (!summary) {
    lines.push('> **没有验证结果。** 验证没有跑成功，下面所有"还原度"数字都不存在。');
  } else {
    const total = summary.targetTotal ?? 0;
    const measured = summary.measured ?? 0;
    const bounded = summary.bounded ?? 0;
    const untested = summary.untested ?? 0;
    lines.push(`- 已发现 ${total} 页，**完整测到 ${measured} 页**${bounded ? `，其中有界置信度 ${bounded} 页` : ''}，没测到 ${untested} 页。`);
    if (Number.isFinite(maxPages) && total > maxPages) {
      lines.push(`- 本次按 \`--max-pages ${maxPages}\` 截断：只覆盖了前 ${maxPages} 页，其余 ${total - maxPages} 页没克隆也没测。`);
    }
    lines.push(`- 站均还原度：**${pct(summary.average)}**（只按真的测到的页算，没测到的不进分母）。`);
    if (summary.worst) {
      lines.push(`- 最差：\`${summary.worst.page}\` @ ${summary.worst.name} ${pct(summary.worst.score)}`);
    }
    if (untested > 0) {
      lines.push('', `> **${untested} 页没有数字。** 这不等于它们看起来没问题——是没有测量结论。`);
      if (blockers.length) {
        lines.push('>', '> 卡住的原因：');
        for (const [text, n] of blockers.slice(0, 6)) lines.push(`> - ${n} 个视口：${text}`);
      }
    }
    if (bounded > 0) {
      lines.push('', '> 有界置信度的页：版面在观察窗口内已经定住，但页面仍在发请求（长轮询 / 埋点）。');
      lines.push('> 截图是终态、分数可信，但这些页背地里还在跑东西，交付前值得人工看一眼。');
    }
  }
  lines.push('');

  if (gaps?.summary) {
    const g = gaps.summary;
    lines.push('## 资产缺口', '');
    lines.push(`- 引用 ${g.refs} 个，本地化 ${g.localized} 个（${pct(g.localizationRate)}）。`);
    lines.push(`- 仍是外链的视觉资产（**必须处理**）：${g.visual} 个——原站 ${g.visualOrigin}，第三方 ${g.visualThird}。`);
    if (g.truncated) lines.push(`- 注意：只扫了 ${g.pages} 页，磁盘上共 ${g.clonedPages} 页，本报告没覆盖后面那些。`);
    lines.push('');
  }

  lines.push('## 包里有什么', '');
  if (delivered) {
    lines.push(`- 交付包：\`deliverable/${delivered}/\``);
    lines.push('  - `site/` 复刻件（可以直接打开）');
    lines.push('  - `fidelity.csv` 逐页逐视口分数');
    lines.push('  - `edit-manifest.md` 改站清单：换域名 / 换图 / 换文案各要动哪些文件');
    lines.push('  - `README.md` 交付包自带的说明');
  } else {
    lines.push('- 交付包没有生成成功，看上面第 5 步的日志。');
  }
  lines.push('');

  lines.push('## 下一步怎么走', '');
  if (skippedVerify) {
    lines.push('1. 补验证：`node core/src/cli.mjs verify <host> --all --resume`（断点续跑，中断后重跑同一条命令即可）。');
  } else if (summary && (summary.untested ?? 0) > 0) {
    lines.push('1. 没测到的页：重跑 `node core/src/cli.mjs verify <host> --all --resume`，已测过的会自动跳过；');
    lines.push('   卡在长轮询的站可以加 `--allow-bounded`，让"版面已定、请求没完"的页按有界置信度计入。');
  } else {
    lines.push('1. 覆盖完整，可以直接进人工检查。');
  }
  lines.push('2. 视觉缺口里的外链资产，按 `edit-manifest.md` 逐项替换。');
  lines.push('3. 分数不能替代断网浏览：导出离线包后拔网线走一遍关键路径。');
  return lines.join('\n') + '\n';
}
