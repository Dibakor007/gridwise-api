import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

dotenv.config();

function apiPlugin(): Plugin {
  return {
    name: 'api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];

        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (url === '/health' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (url === '/api/sample-cases' && req.method === 'GET') {
          const { SAMPLE_CASES } = await import('./src/server/sampleCases');
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(SAMPLE_CASES));
          return;
        }

        if (url === '/optimize-energy' && req.method === 'POST') {
          let bodyStr = '';
          req.on('data', (chunk) => {
            bodyStr += chunk;
          });
          req.on('end', async () => {
            try {
              const body = JSON.parse(bodyStr || '{}');
              const { validateRequest } = await import('./src/server/types');
              const { interpretOperatorNotes } = await import('./src/server/llm-interpreter');
              const { runOptimization } = await import('./src/server/optimizer');

              const validation = validateRequest(body);
              if (!validation.valid || !validation.data) {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(400);
                res.end(JSON.stringify({ error: validation.error || 'Invalid request format' }));
                return;
              }

              const directives = await interpretOperatorNotes(
                validation.data.operator_notes,
                validation.data.battery
              );
              const plan = runOptimization(validation.data, directives);

              res.setHeader('Content-Type', 'application/json');
              res.writeHead(200);
              res.end(JSON.stringify(plan));
            } catch (err: any) {
              console.error('[Dev API Error]:', err);
              res.setHeader('Content-Type', 'application/json');
              res.writeHead(500);
              res.end(
                JSON.stringify({
                  error: 'An unexpected error occurred during energy optimization.',
                  message: err?.message || 'Internal processing error',
                })
              );
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), apiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
