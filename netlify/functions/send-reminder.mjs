import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { runScheduler } from '../lib/core.mjs';

// Runs every minute (Netlify's minimum). It only runs on the published production deploy.
export default async () => {
  const { ok, result } = await runScheduler({ getStore, webpush, env: process.env, now: () => new Date() });
  console.log('send-reminder', ok ? 'ok' : 'FAILED', JSON.stringify(result));
  return new Response(ok ? 'ok' : 'failed');
};

export const config = { schedule: '* * * * *' };
