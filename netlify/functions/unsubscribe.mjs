import { getStore } from '@netlify/blobs';

import { handleUnsubscribe } from '../lib/core.mjs';

export default async (req) => handleUnsubscribe(req, { getStore, env: process.env, now: () => new Date() });
