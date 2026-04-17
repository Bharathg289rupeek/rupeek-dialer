import bcrypt from 'bcryptjs';
import { query } from '../db/connection.js';
import { generateToken } from '../middleware/auth.js';

export default async function authRoutes(fastify) {
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }
    const res = await query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
    const user = res.rows[0];
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

    const token = generateToken(user);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  fastify.get('/api/v1/auth/me', {
    preHandler: fastify.auth,
  }, async (request) => {
    const res = await query(`SELECT id, email, name, role FROM users WHERE id = $1`, [request.user.id]);
    return res.rows[0] || {};
  });
}
