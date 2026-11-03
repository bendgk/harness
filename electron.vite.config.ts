import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // `index` is the kernel (stable); `app` is the hot bundle it requires at
        // runtime. In dev, esbuild rebuilds `app` on save (see src/main/index.ts).
        input: { index: resolve('src/main/index.ts'), app: resolve('src/main/app.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [react()],
    server: { port: Number(process.env.PAPER_DEV_PORT) || 5173 },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
