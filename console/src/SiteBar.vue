<script setup>
/**
 * SiteBar — 站点切换 + 本站操作（星图与工作视图统一用这一个）
 *
 * 为什么改成"下拉 + 操作菜单"：原先星图顶部把**每个站点一个按钮 + 一个 ×**
 * 和四个功能按钮平铺成一行。站点只有两三个时还行，到八个就折成三行，
 * 站点按钮、删除按钮、功能按钮混在一起，既分不清"这是选站"还是"这是干活"，
 * 也随站点数持续膨胀。
 *
 * 现在固定两个控件的宽度：
 *   · 站点下拉   —— 选站；顺带在该站点右侧显示"克隆 N 页"
 *   · 操作菜单   —— 本站能做的事，每项带一行说明；费时/破坏性动作标红
 *
 * 站点状态（发现/已克隆/重合）单列一行小字 —— 这三个数来自**不同的集合**，
 * 挤进一个 61/62 的分数里会骗人（详见 engine 的 /api/sites 注释）。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';

const props = defineProps({
  sites: { type: Array, default: () => [] },
  host: { type: String, default: '' },
  /** [{ id, label, hint, danger?, disabled? }] */
  actions: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['pick', 'action']);

const menuOpen = ref(false);
const root = ref(null);

const current = computed(() => props.sites.find(s => s.host === props.host) ?? null);

/** 下拉里的每站一行：只给"我手上有多少页"，覆盖度在下面那行细说 */
function optionText(s) {
  const label = s.origin || s.host;
  if (s.status === 'partial') {
    // 只做过 SEO 审计的站点（没有侦察也没有克隆）也要能选到，否则审计完就找不到它了
    if (!s.forged && s.audit) return `${label} · 仅审计 ${s.audit.score ?? '—'} 分`;
    return `${label} · 克隆 ${s.forged} 页（未侦察）`;
  }
  if (!s.discovered) return `${label} · 侦察结果为空`;
  return `${label} · 克隆 ${s.forged} 页`;
}

/** 选中站点的三个数分开说，别揉成一个分数 */
const statusText = computed(() => {
  const s = current.value;
  if (!s) return '';
  if (!s.forged && s.audit) return `只做过 SEO 审计（${s.audit.score ?? '—'} 分 · ${s.audit.pages ?? 0} 页 · 评分口径 ${s.audit.scoreMethodVersion ?? '未记录'}${s.audit.baselineEligible === false ? ' · 采集不完整' : ''}）· 没有侦察与克隆产物`;
  if (s.status === 'partial') return `克隆 ${s.forged} 页 · 未做全站侦察（侦察后才有星图与全站视图）`;
  const parts = [`侦察发现 ${s.discovered} 页`, `已克隆 ${s.cloned} 页`];
  if (s.clonedInAtlas) parts.push(`其中 ${s.clonedInAtlas} 页在侦察集合内`);
  if (s.extra) parts.push(`${s.extra} 页为侦察未覆盖、但已克隆`);
  return parts.join(' · ');
});

const onPick = (e) => emit('pick', e.target.value);
const runAction = (a) => {
  if (a.disabled) return;
  menuOpen.value = false;
  emit('action', a.id);
};
function onDocClick(e) { if (menuOpen.value && root.value && !root.value.contains(e.target)) menuOpen.value = false; }
function onKey(e) { if (e.key === 'Escape') menuOpen.value = false; }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); });

/**
 * role="menu" 的 ARIA 键盘模式：菜单一打开就把焦点落到第一项，上下键在项间移动，
 * 关闭时把焦点还回触发按钮。少了这一套，菜单对键盘用户等于"打开了但进不去"。
 */
const menuEl = ref(null);
let menuReturnFocus = null;
const menuItems = () => [...(menuEl.value?.querySelectorAll('.sb-item:not([disabled])') ?? [])];
function onMenuKey(e) {
  const list = menuItems();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
}
watch(menuOpen, async (open) => {
  if (open) {
    menuReturnFocus = document.activeElement;
    await nextTick();
    menuItems()[0]?.focus();
  } else if (menuReturnFocus && typeof menuReturnFocus.focus === 'function') {
    menuReturnFocus.focus();
    menuReturnFocus = null;
  }
});
</script>

<template>
  <div class="sitebar" ref="root">
    <label class="sb-label" for="sb-select">站点</label>
    <select id="sb-select" class="sb-select" :value="host" :disabled="!sites.length" @change="onPick">
      <option v-if="!sites.length" value="">尚无站点 —— 先输入域名点「侦察」</option>
      <option v-for="s in sites" :key="s.host" :value="s.host">{{ optionText(s) }}</option>
    </select>

    <div class="sb-menu-wrap">
      <button class="sb-menu-btn" :disabled="!host" :aria-expanded="menuOpen" aria-haspopup="menu"
        :title="busy ? '已有任务在运行' : '本站可以做的事'" @click="menuOpen = !menuOpen">
        本站操作 <span class="sb-caret" aria-hidden="true">▾</span>
      </button>
      <div class="sb-menu surface" v-if="menuOpen" role="menu" ref="menuEl" @keydown="onMenuKey">
        <button v-for="a in actions" :key="a.id" role="menuitem" class="sb-item"
          :class="{ danger: a.danger }" :disabled="a.disabled" :title="a.hint" @click="runAction(a)">
          <b>{{ a.label }}</b>
          <span v-if="a.hint">{{ a.hint }}</span>
        </button>
        <div v-if="!actions.length" class="sb-item empty">（无可用操作）</div>
      </div>
    </div>

    <span class="sb-status" :title="statusText">{{ statusText }}</span>
  </div>
</template>

<style scoped>
/* 这一块是 v2「深空观测站」留下的：裸 hex / 裸 rgba 各一处，还引用了两个在 v3 里
   已经不存在的 token（--muted / --cyan-line）。undefined 的 var() 会整条声明失效 ——
   颜色退回继承色、边框退回 currentColor —— 于是站点条的标签和边框一直按"未上色"渲染，
   浅色主题下尤其明显。现已全部换成 v3 token（见 style.css 顶部那张表）。 */
.sitebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sb-label { font-size: 11px; color: var(--text-dim); letter-spacing: .5px; }
.sb-select {
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--r-sm); padding: 5px 8px; font-size: 12px; color-scheme: dark; max-width: 300px;
}
.sb-select option { background: var(--surface); color: var(--text); }
:global([data-theme="light"]) .sb-select { color-scheme: light; }
.sb-menu-wrap { position: relative; }
.sb-menu-btn {
  color: var(--text); border: 1px solid var(--border); background: var(--surface-2);
  border-radius: var(--r-sm); padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.sb-menu-btn:disabled { opacity: .45; cursor: not-allowed; }
.sb-caret { font-size: 9px; opacity: .7; }
.sb-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 250px; padding: 4px;
  display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: var(--r-sm);
}
.sb-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  background: none; border: 0; color: var(--text); padding: 7px 9px; border-radius: var(--r-sm);
  font-size: 12px; cursor: pointer; width: 100%;
}
.sb-item:hover:enabled { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.sb-item:disabled { opacity: .4; cursor: not-allowed; }
.sb-item b { font-weight: 600; }
.sb-item span { font-size: 11px; color: var(--text-dim); line-height: 1.35; }
.sb-item.danger b { color: var(--bad); }
.sb-item.empty { color: var(--text-dim); cursor: default; }
.sb-status { font-size: 11px; color: var(--text-dim); max-width: 46ch; line-height: 1.35; }
</style>
