import 'dotenv/config';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const applied = await migrate(pool);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
await pool.end();
