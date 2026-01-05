

const upstream = 'https://dns.nextdns.io/11cc3e/Router';
const binaryType = 'application/dns-message';
const jsonType = 'application/dns-json';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // GET with ?dns= param (base64 wireformat query)
    if (request.method === 'GET' && url.searchParams.has('dns')) {
      return fetch(`${upstream}?dns=${url.searchParams.get('dns')}`, {
        headers: { Accept: binaryType },
      });
    }

    // POST binary DNS message
    if (request.method === 'POST' && request.headers.get('content-type') === binaryType) {
      return fetch(upstream, {
        method: 'POST',
        headers: {
          Accept: binaryType,
          'Content-Type': binaryType,
        },
        body: request.body,  // Streams directly – efficient
      });
    }

    // GET DNS over HTTPS in JSON format (Accept header triggers it)
    if (request.method === 'GET' && request.headers.get('Accept') === jsonType) {
      return fetch(upstream + url.search, {
        headers: { Accept: jsonType },
      });
    }

    // Anything else? Politely nope out
    return new Response('Bad request – use GET ?dns=base64, POST binary, or Accept dns-json', {
      status: 400,
    });
  },
};
