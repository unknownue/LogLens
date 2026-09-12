// check-highlight-contrast.mjs — 校验「搜索高亮」与「关键词调色板」在感知上可分辨，
// 并给出候选色与正文在两种主题下的对比度。用 CIELAB ΔE*ab + WCAG 对比度，不靠肉眼判断。
//
// 用法: node tools/check-highlight-contrast.mjs

// ---- 关键词调色板（App.css 中定义，两主题通用） ----
const KEYWORD = {
  "kw-c0 金黄": "#e6b422",
  "kw-c1 橙": "#f08c28",
  "kw-c2 红": "#e05252",
  "kw-c3 绿": "#6fbf4c",
  "kw-c4 蓝": "#4c9aff",
  "kw-c5 紫": "#b06fe0",
  "kw-c6 青": "#3fc5b7",
  "kw-c7 粉": "#e06fa8",
};

// ---- 正文前景色（两主题的 --text） ----
const ROW_TEXT = {
  "dark 主题正文": "#d4d4d4",
  "light 主题正文": "#1a1a1a",
};

// ---- 候选：搜索用色 ----
const CANDIDATES = {
  "普通命中 靛蓝 #4b3fd6": "#4b3fd6",
  "当前命中 深品红 #c2185b": "#c2185b",
  "当前命中 品红 #ff2d95": "#ff2d95",
};

// ---- 标记文字色候选（反色块上的字） ----
const MARK_TEXT = {
  "白 #ffffff": "#ffffff",
  "近黑 #12121a": "#12121a",
};

// ---- 棋盘底色（两种主题的 --bg），用于判断块本身是否可见 ----
const PAGE_BG = {
  "dark 主题底色": "#1e1e1e",
  "light 主题底色": "#ffffff",
};

// ---------- 色彩换算 ----------
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** sRGB → XYZ(D65) → CIELAB */
function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / 1.0;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 色差（ΔE*ab）：越大越可分辨；≈2.3 是刚可察觉的门槛 */
function deltaE(a, b) {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** WCAG 相对亮度与对比度 */
function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// ---------- 报告 ----------
// 可分辨阈值：ΔE ≥ 25 视为「一眼能分清」，10~25 为「接近但可辨」，<10 视为撞色。
const DISTINCT = 25;
const CLOSE = 10;

console.log("关键词调色板（两主题通用）:");
for (const [name, hex] of Object.entries(KEYWORD)) {
  console.log(`  ${name.padEnd(12)} ${hex}`);
}
console.log("");

let worstOverall = null;
console.log("=== 标记色 vs 关键词调色板（是否撞色） ===");
for (const [cname, chex] of Object.entries(CANDIDATES)) {
  let worst = { d: Infinity, name: "" };
  for (const [kname, khex] of Object.entries(KEYWORD)) {
    const d = deltaE(chex, khex);
    if (d < worst.d) worst = { d, name: kname };
  }
  const verdict =
    worst.d >= DISTINCT ? "OK 与所有关键词色可分辨"
      : worst.d >= CLOSE ? "偏近：与最近关键词色仅「勉强可辨」"
        : "撞色：与最近关键词色几乎无法分辨";
  console.log(`${cname.padEnd(22)} 最近=${worst.name} ΔE=${worst.d.toFixed(1)}  ${verdict}`);
  if (!worstOverall || worst.d < worstOverall.d) worstOverall = { d: worst.d, name: cname, near: worst.name };
}
console.log("");

console.log("=== 标记文字色 vs 标记底色（可读性，需 ≥4.5:1） ===");
for (const [mname, mhex] of Object.entries(MARK_TEXT)) {
  for (const [cname, chex] of Object.entries(CANDIDATES)) {
    const c = contrast(mhex, chex);
    console.log(`${mname.padEnd(14)} on ${cname.padEnd(22)} ${c.toFixed(2)}:1  ${c >= 4.5 ? "OK" : "不足"}`);
  }
}
console.log("");

console.log("=== 标记块 vs 页面底色（块本身是否看得见，需 ≥1.3:1） ===");
for (const [cname, chex] of Object.entries(CANDIDATES)) {
  for (const [bname, bhex] of Object.entries(PAGE_BG)) {
    const c = contrast(chex, bhex);
    console.log(`${cname.padEnd(22)} on ${bname.padEnd(16)} ${c.toFixed(2)}:1  ${c >= 1.3 ? "OK" : "偏弱"}`);
  }
}
console.log("");

console.log("=== 结论 ===");
console.log(`两个标记色中，与关键词调色板最近的是: ${worstOverall.name}`);
console.log(`  与 ${worstOverall.near} 的 ΔE = ${worstOverall.d.toFixed(1)}  (≥${DISTINCT} 视为一眼可分)`);
