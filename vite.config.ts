import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
      ignored: ["**/src-tauri/**"],
    },
  },
}));
