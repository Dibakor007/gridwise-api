import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleGetSampleCases, handleHealth, handleOptimizeEnergy } from './src/server/handler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS headers for judging harness or external API callers
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Required Challenge Endpoints
app.get('/health', handleHealth);
app.post('/optimize-energy', handleOptimizeEnergy);

// Helper API for web UI
app.get('/api/sample-cases', handleGetSampleCases);

// Serve static frontend in production if dist directory exists
const distPath = path.resolve(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[GridWise API Server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[GridWise API Server] Health endpoint: http://0.0.0.0:${PORT}/health`);
  console.log(`[GridWise API Server] Optimize endpoint: http://0.0.0.0:${PORT}/optimize-energy`);
});
