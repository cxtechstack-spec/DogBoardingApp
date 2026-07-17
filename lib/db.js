// Singleton Prisma client — import this everywhere instead of creating new instances.
import { PrismaClient } from './generated/prisma/index.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// Prisma 7 requires an explicit driver adapter for SQLite instead of the bundled engine.
const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });
export default db;
