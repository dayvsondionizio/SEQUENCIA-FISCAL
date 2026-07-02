import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';

// In production this route is served by the Vercel serverless function at
// api/danfe.ts. This plugin only runs for `vite dev`/`vite preview` (never
// during `vite build`), so it mirrors that same route locally without
// requiring `vercel dev` or a Vercel login just to test the DANFE download.
function localDanfeApiPlugin(): Plugin {
  return {
    name: 'local-danfe-api',
    async configureServer(server) {
      const express = (await import('express')).default;
      const danfeHandler = (await import('./api/danfe')).default;
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      app.post('/', danfeHandler);
      server.middlewares.use('/api/danfe', app);
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss(), localDanfeApiPlugin()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
