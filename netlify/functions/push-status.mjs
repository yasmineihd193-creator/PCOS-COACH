import { getStore } from '@netlify/blobs';

import { handleStatus } from '../lib/core.mjs';

export default async (req) => handleStatus(req, { getStore, env: process.env, now: () => new Date() });
