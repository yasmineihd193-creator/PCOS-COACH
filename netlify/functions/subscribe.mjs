import { getStore } from '@netlify/blobs';

import { handleSubscribe } from '../lib/core.mjs';

export default async (req) => handleSubscribe(req, { getStore, env: process.env, now: () => new Date() });
