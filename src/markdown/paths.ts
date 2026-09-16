/**
 * 路径工具：把 Markdown 文档里的相对链接 / 图片地址解析成绝对路径。
 *
 * 为什么会单独成一个纯模块：Markdown 预览里最容易被写错、又最难手工验证的就是路径
 * 解析（`./x.md`、`../a/b.png`、`%20` 转义、`file:///D:/a.md`、`x.md#锚点`…）。
 * 拆出来就能用 `node --test` 直接覆盖（`tools/verify-markdown.test.mjs`），
 * 不必开浏览器点进点出；也让 `markdown.ts` 的渲染器保持简单。
 *
 * 只处理 Windows 路径（本项目只发布 Windows 版），但分隔符按文档原样跟随：
 * 文档路径用 `\` 就产出 `\`，用 `/` 就产出 `/`。
 */

/**
 * 形如 `http:` / `mailto:` / `file:` 的 URL scheme 判定（不含 `#锚点` 与相对路径）。
 *
 * 冒号前要求**至少两个字符**：Windows 盘符路径（`D:\logs\a.log`）也是「字母 + 冒号」，
 * 一旦按 scheme 处理，本地绝对路径就会被送去浏览器打开而不是交给系统。
 */
export function isSchemeHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(href);
}

/** 相对链接里的锚点与查询串：`a.md#sec` → `a.md`。 */
export function stripHashAndQuery(href: string): string {
  return href.split("#")[0].split("?")[0];
}

/** 取路径中的锚点（无则空串）。 */
export function hashOf(href: string): string {
  const i = href.indexOf("#");
  return i < 0 ? "" : href.slice(i + 1);
}

/** 目录部分（`D:\docs\a.md` → `D:\docs`；`a.md` → 空串）。 */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** 文件名（`D:\docs\a.md` → `a.md`）。 */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** 扩展名（小写，不带点；无扩展名返回空串）。 */
export function extensionOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 是否是本应用能自己预览的 Markdown 文件（决定「相对链接点开是进新 tab 还是交给系统」）。 */
export function isMarkdownPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "md" || ext === "markdown";
}

/** `file://` URL → 本地路径（`file:///D:/a/b.md` → `D:/a/b.md`）。 */
function fromFileUrl(href: string): string {
  const rest = href.replace(/^file:\/\//i, "");
  // `file:///D:/x` 去掉前导 `/` 才是 Windows 盘符路径；UNC（file://server/share）保留 //
  const decoded = safeDecode(rest);
  return /^\/[a-z]:/i.test(decoded) ? decoded.slice(1) : decoded;
}

/** `decodeURIComponent` 对畸形转义会抛错（`%zz`），此时退回原文。 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 是否已经是绝对路径（盘符 / UNC / 以分隔符开头）。 */
function isAbsolutePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path) || /^[\\/]/.test(path);
}

/**
 * 解析 Markdown 里的链接目标为绝对路径。
 *
 * - `href` 是 scheme URL（http/https/mailto/…）或纯锚点（`#x`）→ 原样返回，
 *   调用方先用 {@link isSchemeHref} / `href.startsWith("#")` 分流；
 * - 已经是绝对路径 → 归一化后返回；
 * - 其它按「相对文档所在目录」解析，并消掉 `.` / `..` 段。
 *
 * 分隔符跟随 `docPath`；`docPath` 为空时按 `\` 输出（Windows 默认）。
 */
export function resolveRelativePath(docPath: string, href: string): string {
  const clean = stripHashAndQuery(href);
  const sep = !docPath || docPath.includes("\\") ? "\\" : "/";
  const target = /^file:\/\//i.test(clean) ? fromFileUrl(clean) : safeDecode(clean);
  const normalized = target.replace(/[\\/]+/g, sep === "\\" ? "\\" : "/");

  if (isAbsolutePath(normalized)) {
    return normalizeSegments(normalized, sep);
  }
  const dir = dirName(docPath);
  return dir ? normalizeSegments(`${dir}${sep}${normalized}`, sep) : normalizeSegments(normalized, sep);
}

/**
 * 消掉路径中的 `.` / `..` 段，并还原盘符 / UNC / 根相对前缀。
 *
 * 根之上的 `..` 直接丢弃（`D:\..\x` → `D:\x`）；只有「纯相对路径」（解析结果里
 * 一个段都不剩）才保留 `..`，避免把 `..\..\x` 这类相对写法抹成空串。
 */
function normalizeSegments(path: string, sep: string): string {
  const splitRe = sep === "\\" ? /[\\/]/ : /\//;
  const isUnc = /^[\\/]{2}/.test(path);
  const drive = /^[a-z]:/i.exec(path)?.[0] ?? "";
  const leadSep = !drive && !isUnc && /^[\\/]/.test(path);

  const parts = path
    .replace(/^[a-z]:/i, "")
    .split(splitRe)
    .filter((p) => p !== "" && p !== ".");

  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > 0) {
        out.pop();
      } else if (!drive && !leadSep && !isUnc) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }

  const body = out.join(sep);
  if (isUnc) {
    return `${sep}${sep}${body}`;
  }
  if (drive) {
    return `${drive}${sep}${body}`;
  }
  return leadSep ? `${sep}${body}` : body;
}
