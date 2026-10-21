import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The API port follows SLATE_PORT (default 5174) so a second instance can run against another root.
const api = `http://127.0.0.1:${process.env.SLATE_PORT || 5174}`

// pdf.js decodes JBIG2 and CCITT images (the 1-bit masks a screenshot or scan PDF carries), JPEG 2000 and ICC colour
// with WebAssembly it fetches at run time as `wasmUrl` + a fixed file name. Without those files such a page draws
// blank, so they are served whole at /pdfjs/wasm/: from node_modules in dev, copied into dist/ by a build (PdfEl.jsx).
const WASM_DIR = fileURLToPath(new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url))
const WASM_FILES = fs.readdirSync(WASM_DIR).filter(f => /^(jbig2|openjpeg|qcms)|^LICENSE/.test(f))
const WASM_TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript' }
const pdfjsWasm = () => ({
  name: 'slate-pdfjs-wasm',
  configureServer(server) {
    server.middlewares.use('/pdfjs/wasm/', (req, res, next) => {
      const f = decodeURIComponent(req.url.split('?')[0].slice(1))
      if (!WASM_FILES.includes(f)) return next()
      res.setHeader('Content-Type', WASM_TYPES[path.extname(f)] || 'text/plain')
      fs.createReadStream(path.join(WASM_DIR, f)).pipe(res)
    })
  },
  generateBundle() {
    for (const f of WASM_FILES) this.emitFile({ type: 'asset', fileName: `pdfjs/wasm/${f}`, source: fs.readFileSync(path.join(WASM_DIR, f)) })
  },
})

export default defineConfig({
  plugins: [react(), pdfjsWasm()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/files': { target: api, changeOrigin: false },
    },
  },
})
