import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { parseApiBaseUrl } from './src/api/base-url';
import { contentSecurityPolicy } from './src/lib/csp';

/**
 * Builds only: the page carries its own CSP (see src/lib/csp.ts). Not in dev, where Vite's HMR
 * client needs inline scripts and a websocket.
 */
function cspMeta(apiOrigin: string): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: contentSecurityPolicy(apiOrigin),
        },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => {
  // Throws on a malformed VITE_API_BASE_URL, so a bad setting fails the build, not the page.
  const apiOrigin = parseApiBaseUrl(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE_URL);
  return {
    plugins: [react(), tailwindcss(), cspMeta(apiOrigin)],
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
  };
});
