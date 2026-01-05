const doh = 'https://dns.nextdns.io/11cc3e/Router';
const dohjson = 'https://dns.nextdns.io/11cc3e/Router';
const contype = 'application/dns-message';
const jstontype = 'application/dns-json';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.searchParams.has('dns')) {
      return fetch(`${doh}?dns=${url.searchParams.get('dns')}`, {
        headers: { 'Accept': contype },
      });
    }

    if (request.method === 'POST' && request.headers.get('content-type') === contype) {
      return fetch(doh, {
        method: 'POST',
        headers: {
          'Accept': contype,
          'Content-Type': contype,
        },
        body: request.body,
      });
    }

    if (request.method === 'GET' && request.headers.get('Accept') === jstontype) {
      return fetch(dohjson + url.search, {
        headers: { 'Accept': jstontype },
      });
    }

    return new Response('Bad request – try ?dns= or POST', { status: 400 });
  }
};