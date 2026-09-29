import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// The API port follows SLATE_PORT (default 5174) so a second instance can run against another root.
const api = `http://127.0.0.1:${process.env.SLATE_PORT || 5174}`
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/files': { target: api, changeOrigin: false },
    },
  },
})
