import ReactDOM from "react-dom/client";
import App from "./App";

// 注意：不使用 React.StrictMode。
// 原因：StrictMode 在开发模式会对 effect 执行「挂载→卸载→再挂载」，
// 与 Tauri 的异步 listen（返回 Promise<UnlistenFn>）产生竞态，
// 可能导致事件监听被意外注销，日志「首次能显示、后续不刷新」。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
