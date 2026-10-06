import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { handleTestPush } from '../lib/core.mjs';

export default async (req) => handleTestPush(req, { getStore, webpush, env: process.env, now: () => new Date() });
