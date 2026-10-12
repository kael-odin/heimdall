/**
 * png-stat — 一张 PNG 里到底有多少"看得见的像素"
 *
 * 用途只有一个，但很关键：**光栅化/截图之后要能自证不是一张空图**。
 * WebGL 画布（没有 preserveDrawingBuffer）读回来是全透明的，Playwright 对它截图
 * 也可能拿到一张纯透明图（元素还没画完、被遮住、尺寸塌成 0）。
 * 把这种图当"已处理"写进产物，就是拿一张空白去冒充内容 —— 比缺了更糟，
 * 因为它从此不在任何缺口清单里（实测 moonshot.cn 首页整条 hero 动画带就是这么丢的）。
 */
import { PNG } from 'pngjs';

/** alpha 超过这个值的像素算"看得见"（与 capture 里画布判据同一个口径） */
export const ALPHA_MIN = 8;

/**
 * 统计不透明像素数。解不出来（不是 PNG / 截断）返回 -1 —— 调用方据此**拒绝**这张图，
 * 而不是当成 0 悄悄放过。
 */
export function countOpaquePng(buf) {
  try {
    const png = PNG.sync.read(buf);
    let n = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > ALPHA_MIN) n++;
    return n;
  } catch { return -1; }
}
