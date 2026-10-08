import { Hono } from 'hono';
import { makeRepo } from '@sellable/db';
import { createApp } from '@sellable/api';

const repo = makeRepo(process.env.DB_URL);
const app: Hono = createApp(repo);

export default app;
