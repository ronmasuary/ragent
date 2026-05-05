import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';

// Build a minimal express app mimicking startHttpServer mutex + auth behavior

function buildTestApp(agentChat: (msg: string) => Promise<string>, apiKey?: string) {
  const app = express();
  app.use(express.json());

  let isRunning = false;
  let gen = 0;

  function requireAuth(req: express.Request, res: express.Response): boolean {
    if (!apiKey) return false;
    if (req.headers['x-api-key'] !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return true;
    }
    return false;
  }

  app.post('/chat', async (req, res) => {
    if (requireAuth(req, res)) return;

    const { message } = req.body as { message?: string };
    if (!message) { res.status(400).json({ error: 'Missing message' }); return; }

    if (isRunning) { res.status(409).json({ error: 'Agent busy' }); return; }

    const myGen = ++gen;
    isRunning = true;

    const chatPromise = agentChat(message).finally(() => {
      if (gen === myGen) isRunning = false;
    });

    try {
      const response = await Promise.race([
        chatPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
      ]);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: 0 });
  });

  return app;
}

describe('HTTP server — /chat', () => {
  it('returns 200 with response', async () => {
    const app = buildTestApp(async () => 'hello from agent');
    const res = await request(app).post('/chat').send({ message: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('hello from agent');
  });

  it('returns 400 on missing message', async () => {
    const app = buildTestApp(async () => '');
    const res = await request(app).post('/chat').send({});
    expect(res.status).toBe(400);
  });

  /**
   * Use a shared http.Server so all requests share the same isRunning/gen state.
   * request(app) creates a new ephemeral server per call — state is not shared.
   */
  it('generation counter mutex blocks concurrent /chat requests', { timeout: 10000 }, async () => {
    let resolveFn!: () => void;
    const longChat = new Promise<string>(resolve => { resolveFn = () => resolve('done'); });

    const app = buildTestApp(() => longChat);
    const server = http.createServer(app);

    await new Promise<void>(r => server.listen(0, r));

    try {
      const agent = request(server);

      // Use .end() to force the HTTP request to start immediately (supertest is lazy otherwise)
      let firstStatus = 0;
      const firstDone = new Promise<void>(resolve => {
        agent.post('/chat').send({ message: 'slow' }).end((_err, res) => {
          firstStatus = res?.status ?? 0;
          resolve();
        });
      });

      // Give server time to acquire mutex
      await new Promise(r => setTimeout(r, 100));

      // Second request — mutex held, should be 409
      const second = await agent.post('/chat').send({ message: 'fast' });
      expect(second.status).toBe(409);
      expect(second.body.error).toContain('busy');

      // Release first
      resolveFn();
      await firstDone;
      expect(firstStatus).toBe(200);

      // Mutex released — third request should succeed
      const third = await agent.post('/chat').send({ message: 'after' });
      expect(third.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('GET /health returns ok', async () => {
    const app = buildTestApp(async () => '');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('HTTP server — API key auth', () => {
  it('no API_KEY set — all endpoints open', async () => {
    const app = buildTestApp(async () => 'ok');
    const res = await request(app).post('/chat').send({ message: 'hi' });
    expect(res.status).toBe(200);
  });

  it('API_KEY set — correct key returns 200', async () => {
    const app = buildTestApp(async () => 'ok', 'secret');
    const res = await request(app)
      .post('/chat')
      .set('x-api-key', 'secret')
      .send({ message: 'hi' });
    expect(res.status).toBe(200);
  });

  it('API_KEY set — wrong key returns 401', async () => {
    const app = buildTestApp(async () => 'ok', 'secret');
    const res = await request(app)
      .post('/chat')
      .set('x-api-key', 'wrong')
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('API_KEY set — missing key returns 401', async () => {
    const app = buildTestApp(async () => 'ok', 'secret');
    const res = await request(app).post('/chat').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('public endpoint /health bypasses auth', async () => {
    const app = buildTestApp(async () => 'ok', 'secret');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
