import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Renderer surfaces are plain per-component HTML files (src/renderer/surfaces)
// loaded directly by the window manager — the same files that rendered in
// WKWebView/WebView2 during the shared-ui experiment. Only main + preload
// need compilation.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // sandbox:false preload can be ESM-free CommonJS; keep default cjs
        }
      }
    }
  }
})
