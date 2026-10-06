// Server-side proxy to the Anthropic API for meal-photo analysis.
// Keeps the API key out of the browser entirely — the client only ever
// talks to this endpoint, never to api.anthropic.com directly.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ code: 'backend_error', message: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set as an environment variable.');
    return { statusCode: 500, body: JSON.stringify({ code: 'backend_error', message: 'Scanning is not configured on this deployment yet.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ code: 'invalid_json' }) };
  }

  const { imageBase64, mediaType, prompt } = body || {};
  if (!imageBase64 || !mediaType || !prompt) {
    return { statusCode: 400, body: JSON.stringify({ code: 'invalid_json', message: 'Missing image or prompt.' }) };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Anthropic API error', res.status, errText);
      const code = res.status === 429 ? 'rate_limited' : 'backend_error';
      return { statusCode: 502, body: JSON.stringify({ code }) };
    }

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return { statusCode: 502, body: JSON.stringify({ code: 'empty_completion' }) };
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Could not parse model output as JSON:', cleaned);
      return { statusCode: 502, body: JSON.stringify({ code: 'invalid_json' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
  } catch (e) {
    console.error('analyze-food error', e);
    return { statusCode: 500, body: JSON.stringify({ code: 'backend_error' }) };
  }
};
