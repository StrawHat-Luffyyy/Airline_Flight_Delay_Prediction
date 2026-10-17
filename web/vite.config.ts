import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The globe chunk is lazy, so the dev optimizer would discover these late and re-bundle React
  // mid-session (two React copies). Pre-bundle them up front.
  optimizeDeps: {
    include: ['three', '@react-three/fiber', 'topojson-client', 'motion'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
