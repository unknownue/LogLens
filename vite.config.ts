import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * PostCSS 插件：KaTeX 的 @font-face 只保留 woff2 回退链。
 *
 * 为什么需要：`katex.min.css` 给每个字体列了 woff2 / woff / ttf 三种格式
 * （20 个字体 × 3 = 约 1 MB），Vite 会把 url() 引用到的资源全部 emit 出来 ——
 * 而这些资源会一起被打进 exe。WebView2（常青 Edge）百分百支持 woff2，
 * woff/ttf 是给 IE 时代的浏览器留的，本项目 target 是 chrome107，永远用不到。
 *
 * 只改 KaTeX 自己的 CSS：判据是文件路径含 `katex`，且只在确实找到 woff2 时才改写
 * （KaTeX 未来若换写法，这里会安静地不改，最坏结果就是回到「三种格式都打包」）。
 */
const katexWoff2Only = {
  postcssPlugin: "katex-woff2-only",
  Once(root: any, { result }: any) {
    if (!String(result.opts?.from ?? "").includes("katex")) {
      return;
    }
    root.walkAtRules("font-face", (rule: any) => {
      const src = rule.nodes?.find((n: any) => n.type === "decl" && n.prop === "src");
      if (!src) {
        return;
      }
      const parts = String(src.value).split(",");
      const woff2 = parts.filter((part: string) => part.includes("woff2"));
      if (woff2.length > 0) {
        src.value = woff2.join(",").trim();
      }
    });
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // KaTeX 字体裁剪（见上方插件说明）。
  css: {
    postcss: {
      plugins: [katexWoff2Only as never],
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    注意：原 1420/1421 落在 Windows TCP 排除端口范围 1401-2000 内（WSL2 保留），
  //    导致 EACCES，故改用 5173/5174。
  server: {
    port: 5173,
    strictPort: true,
    // 强制绑定 IPv4 loopback，避免 Windows 上 `::1` (IPv6) 的 EACCES 绑定失败
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : {
          protocol: "ws",
          host: "127.0.0.1",
          port: 5174,
        },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: [
        "**/src-tauri/**",
        // 4. 编辑器/工具的「原子写」临时文件：写完即删，但 chokidar 会在中间态去 watch 它，
        //    Windows 上拿到 EBUSY 并且是未捕获错误 —— 直接把 dev server 打挂
        //    （实测：DSH 写入 tools/*.mjs 时出现 `.<name>.<pid>.<uuid>.tmpdir`，
        //     dev server 以 `EBUSY: resource busy or locked, watch ...` 退出）。
        "**/.*.tmpdir/**",
        "**/*.tmp",
        "**/*.swp",
        "**/*.swx",
        "**/~$*",
      ],
    },
  },
  // 发布构建参数：WebView2 随 Edge 常青更新（本项目要求 Win10 1809+），
  // 以 Chrome 107 为转译下限即可，避免向更老浏览器转译造成产物体积膨胀；
  // 生产包不产出 sourcemap。
  build: {
    target: "chrome107",
    minify: "esbuild",
    sourcemap: false,
    // 字体永远不内联成 data: URL。
    //
    // 为什么：CSP 是 `font-src 'self'`，不放行 `data:`。而 Vite 默认把小于 4 KB 的
    // 资源内联，`KaTeX_Size3-Regular.woff2` 只有 3624 B —— 正好落在阈值内，于是打包版
    // **打开任意 Markdown 都会报一条 CSP 错误**，用到 Size3 字形的公式（`\left( \right)`、
    // `\bigg` 这类大号定界符）退化成回退字体。dev 端 CSP 为空，所以只有打包版能复现
    // （由 tools/smoke-release.mjs 抓到的）。
    // 前端整体内嵌在 exe 里，多一个资源文件不产生任何网络开销，没有内联的必要。
    assetsInlineLimit: (filePath: string) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
}));
