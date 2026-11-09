export function auditScoreTrend(history) {
  const records = (history ?? []).filter(x => x?.kind === 'audit' && Number.isFinite(x.score));
  if (!records.length) return { points: [], excluded: 0, legacy: false };
  const version = records.at(-1).scoreMethodVersion;
  const legacy = !Number.isSafeInteger(version) || version < 1;
  const compatible = legacy ? records.slice(-1) : records.filter(x => x.scoreMethodVersion === version);
  return {
    points: compatible.map(x => ({ at: x.at, v: x.score })),
    excluded: records.length - compatible.length,
    legacy,
  };
}
