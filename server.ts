import { makeRepo } from '@sellable/db';
import { createApp } from '@sellable/api';

const repo = makeRepo(process.env.DB_URL);

export default createApp(repo);
