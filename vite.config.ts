import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Exact-match alias so addons that import 'three' share the WebGPU build,
// while 'three/addons/*' still resolves through the package exports.
// Local `npm run dev` / `npm run build` stay at `/`.
// GitHub Pages sets VITE_BASE=/northline-car-line/ so asset URLs match the project site.
const base = process.env.VITE_BASE || '/'

export default defineConfig({
  base,
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: fileURLToPath(new URL('./node_modules/three/build/three.webgpu.js', import.meta.url)),
      },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 4317,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4317,
    strictPort: true,
  },
})
