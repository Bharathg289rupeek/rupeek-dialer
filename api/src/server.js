import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { authMiddleware } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import leadRoutes from './routes/leads.js';
import agentRoutes from './routes/agents.js';
import exotelRoutes from './routes/exotel.js';
import sourceRoutingRoutes from './routes/source-routing.js';
import routingConfigRoutes, { callLogRoutes, dashboardRoutes } from './routes/dashboard.js';
import { startWorkers, stopWorkers } from './workers/index.js';

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  trustProxy: true,
});

// Plugins
await app.register(cors, {
  origin: true,
  credentials: true,
});

await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Auth decorator — so routes can use { preHandler: fastify.auth }
app.decorate('auth', authMiddleware);

// Health check
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Register routes
await app.register(authRoutes);
await app.register(leadRoutes);
await app.register(agentRoutes);
await app.register(exotelRoutes);
await app.register(sourceRoutingRoutes);
await app.register(routingConfigRoutes);
await app.register(callLogRoutes);
await app.register(dashboardRoutes);

// Serve dashboard static files in production
const dashboardPath = path.join(__dirname, '../../dashboard/dist');
try {
  await app.register(fastifyStatic, {
    root: dashboardPath,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
  });
  // SPA fallback: serve index.html for any non-API route
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html', dashboardPath);
  });
} catch {
  // Dashboard not built yet — fine in dev
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({ error: 'Not found' });
  });
}

// Start
const port = parseInt(process.env.PORT || '3000');
const host = '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`Server running on ${host}:${port}`);

  // Start background workers
  if (process.env.DISABLE_WORKERS !== 'true') {
    await startWorkers();
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down...`);
    await stopWorkers();
    await app.close();
    process.exit(0);
  });
}
