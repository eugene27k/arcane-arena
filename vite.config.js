import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    // 5173 unless the environment names one — lets a second dev server run
    // beside the first without either of them silently drifting to a new port.
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
});
