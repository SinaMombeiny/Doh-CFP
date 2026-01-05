// Clean DoH proxy for NextDNS on Cloudflare Pages
// Handles GET (?dns=), POST binary, JSON, plus CORS preflight for browsers

const upstream = 'https://dns.nextdns.io/11cc3e/Router';
const binaryType = 'application/dns-message';
const jsonType = 'application/dns-json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders,
        status: 204,
      });
    }

    const url = new URL(request.url);

    // GET with ?dns= (standard wireformat)
    if (request.method === 'GET' && url.searchParams.has('dns')) {
      const response = await fetch(`${upstream}?dns=${url.searchParams.get('dns')}`, {
        headers: { Accept: binaryType },
      });
      return addCors(response);
    }

    // POST binary message
    if (request.method === 'POST' && request.headers.get('content-type') === binaryType) {
      const response = await fetch(upstream, {
        method: 'POST',
        headers: {
          Accept: binaryType,
          'Content-Type': binaryType,
        },
        body: request.body,
      });
      return addCors(response);
    }

    // GET JSON format
    if (request.method === 'GET' && request.headers.get('Accept') === jsonType) {
      const response = await fetch(upstream + url.search, {
        headers: { Accept: jsonType },
      });
      return addCors(response);
    }

    // Bad request – with CORS so browsers don't freak
    return new Response('Bad request – try GET with ?dns=base64 or POST binary', {
      status: 400,
      headers: corsHeaders,
    });
  },
};

// Helper to slap CORS on proxied responses (upstream has it, but safe)
async function addCors(response) {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
