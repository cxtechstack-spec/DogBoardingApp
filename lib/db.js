// Singleton Prisma client — import this everywhere instead of creating new instances.
import { PrismaClient } from './generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires an explicit driver adapter — pg works with any standard
// Postgres provider (Neon, Render Postgres, Supabase, etc.), not just one.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });
export default db;
