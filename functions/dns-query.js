// Advanced DNS over HTTPS (DoH) Proxy for Vercel
// Optimized for censorship resistance, privacy, and speed

const DOH_PROVIDERS = [
  // Primary - privacy-focused, no logging
  { url: "https://freedns.controld.com/family", name: "ControlD" },
  //{ url: "https://family.dns.mullvad.net/dns-query", name: "Mullvad" },
  // Fallbacks - major providers (harder to block completely)
]

const DNS_MESSAGE_TYPE = "application/dns-message"
const DNS_JSON_TYPE = "application/dns-json"

export const runtime = "edge"
export const preferredRegion = ["dxb1", "fra1", "cdg1", "arn1"]

interface CacheEntry {
  data: ArrayBuffer
  timestamp: number
  ttl: number
}

const dnsCache = new Map<string, CacheEntry>()
const DEFAULT_CACHE_TTL = 300000 // 5 minutes default
const MAX_CACHE_SIZE = 5000

const providerHealth = new Map<string, { failures: number; lastCheck: number }>()
const HEALTH_RESET_INTERVAL = 60000 // Reset health after 1 minute

const inFlightRequests = new Map<string, Promise<ArrayBuffer>>()

function addPadding(length: number = Math.floor(Math.random() * 128) + 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function getPrivacyHeaders(): HeadersInit {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
  ]

  return {
    Accept: DNS_MESSAGE_TYPE,
    "Content-Type": DNS_MESSAGE_TYPE,
    "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
    // Padding header to vary request size
    "X-Padding": addPadding(),
  }
}

function getHealthyProviders(): typeof DOH_PROVIDERS {
  const now = Date.now()

  return [...DOH_PROVIDERS].sort((a, b) => {
    const healthA = providerHealth.get(a.url)
    const healthB = providerHealth.get(b.url)

    // Reset old health data
    if (healthA && now - healthA.lastCheck > HEALTH_RESET_INTERVAL) {
      providerHealth.delete(a.url)
    }
    if (healthB && now - healthB.lastCheck > HEALTH_RESET_INTERVAL) {
      providerHealth.delete(b.url)
    }

    const failuresA = providerHealth.get(a.url)?.failures || 0
    const failuresB = providerHealth.get(b.url)?.failures || 0

    return failuresA - failuresB
  })
}

function markProviderFailed(url: string): void {
  const current = providerHealth.get(url) || { failures: 0, lastCheck: Date.now() }
  providerHealth.set(url, {
    failures: current.failures + 1,
    lastCheck: Date.now(),
  })
}

async function raceProviders(
  makeRequest: (provider: (typeof DOH_PROVIDERS)[0]) => Promise<Response>,
  timeout = 3000,
): Promise<Response> {
  const providers = getHealthyProviders()

  // Start with first 3 healthy providers racing
  const racingProviders = providers.slice(0, 3)

  const racePromises = racingProviders.map(async (provider) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await makeRequest(provider)
      clearTimeout(timeoutId)

      if (!response.ok) {
        markProviderFailed(provider.url)
        throw new Error(`Provider ${provider.name} returned ${response.status}`)
      }

      return { response, provider }
    } catch (error) {
      clearTimeout(timeoutId)
      markProviderFailed(provider.url)
      throw error
    }
  })

  // Use Promise.any to get the first successful response
  try {
    const result = await Promise.any(racePromises)
    return result.response
  } catch {
    // All racing providers failed, try remaining sequentially
    for (const provider of providers.slice(3)) {
      try {
        const response = await makeRequest(provider)
        if (response.ok) return response
        markProviderFailed(provider.url)
      } catch {
        markProviderFailed(provider.url)
      }
    }
    throw new Error("All DNS providers failed")
  }
}

function getCacheKey(data: string | ArrayBuffer): string {
  if (typeof data === "string") {
    return `dns:${data}`
  }
  // For binary data, create a hash-like key
  const arr = new Uint8Array(data)
  let hash = 0
  for (let i = 0; i < Math.min(arr.length, 32); i++) {
    hash = (hash << 5) - hash + arr[i]
    hash = hash & hash
  }
  return `dns:bin:${hash}`
}

function getFromCache(key: string): ArrayBuffer | null {
  const cached = dnsCache.get(key)
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data
  }
  dnsCache.delete(key)
  return null
}

function setCache(key: string, data: ArrayBuffer, ttl?: number): void {
  // LRU-like eviction
  if (dnsCache.size >= MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(dnsCache.keys()).slice(0, 100)
    keysToDelete.forEach((k) => dnsCache.delete(k))
  }
  dnsCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttl || DEFAULT_CACHE_TTL,
  })
}

function extractTTLFromResponse(data: ArrayBuffer): number {
  try {
    const view = new DataView(data)
    // DNS header is 12 bytes, TTL is at offset 6 in answer section
    // This is a simplified extraction - proper parsing would be more complex
    if (data.byteLength > 20) {
      // Skip header and question, find answer TTL
      let offset = 12
      // Skip question section (simplified)
      while (offset < data.byteLength - 4 && view.getUint8(offset) !== 0) {
        offset++
      }
      offset += 5 // Skip null byte and QTYPE/QCLASS

      // Now in answer section, TTL is at +6 from name pointer
      if (offset + 10 < data.byteLength) {
        offset += 6 // Skip name pointer, type, class
        const ttl = view.getUint32(offset)
        if (ttl > 0 && ttl < 86400) {
          // Sanity check: 0 to 24 hours
          return ttl * 1000 // Convert to milliseconds
        }
      }
    }
  } catch {
    // Fallback to default
  }
  return DEFAULT_CACHE_TTL
}

async function deduplicatedFetch(key: string, fetchFn: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const existing = inFlightRequests.get(key)
  if (existing) {
    return existing
  }

  const promise = fetchFn().finally(() => {
    inFlightRequests.delete(key)
  })

  inFlightRequests.set(key, promise)
  return promise
}

function getResponseHeaders(contentType: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    "X-DNS-Prefetch-Control": "off",
    "Referrer-Policy": "no-referrer",
  }
}

// Handle GET requests
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const dnsParam = searchParams.get("dns")
  const acceptHeader = request.headers.get("Accept")
  const nameParam = searchParams.get("name")
  const typeParam = searchParams.get("type") || "A"

  // Handle JSON API requests
  if (acceptHeader === DNS_JSON_TYPE || nameParam) {
    const cacheKey = getCacheKey(`json:${nameParam}:${typeParam}`)
    const cached = getFromCache(cacheKey)
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: getResponseHeaders(DNS_JSON_TYPE),
      })
    }

    const data = await deduplicatedFetch(cacheKey, async () => {
      const response = await raceProviders((provider) =>
        fetch(`${provider.url}?name=${encodeURIComponent(nameParam || "")}&type=${typeParam}`, {
          method: "GET",
          headers: {
            ...getPrivacyHeaders(),
            Accept: DNS_JSON_TYPE,
          },
        }),
      )
      return response.arrayBuffer()
    })

    setCache(cacheKey, data)

    return new Response(data, {
      status: 200,
      headers: getResponseHeaders(DNS_JSON_TYPE),
    })
  }

  // Handle wireformat GET requests
  if (dnsParam) {
    const cacheKey = getCacheKey(dnsParam)
    const cached = getFromCache(cacheKey)
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: getResponseHeaders(DNS_MESSAGE_TYPE),
      })
    }

    const data = await deduplicatedFetch(cacheKey, async () => {
      const response = await raceProviders((provider) =>
        fetch(`${provider.url}?dns=${dnsParam}`, {
          method: "GET",
          headers: getPrivacyHeaders(),
        }),
      )
      return response.arrayBuffer()
    })

    const ttl = extractTTLFromResponse(data)
    setCache(cacheKey, data, ttl)

    return new Response(data, {
      status: 200,
      headers: getResponseHeaders(DNS_MESSAGE_TYPE),
    })
  }

  return new Response("Missing dns parameter", { status: 400 })
}

// Handle POST requests
export async function POST(request: Request) {
  const contentType = request.headers.get("Content-Type")

  if (contentType !== DNS_MESSAGE_TYPE) {
    return new Response("Invalid Content-Type", { status: 400 })
  }

  const body = await request.arrayBuffer()
  const cacheKey = getCacheKey(body)

  // Check cache for POST requests too
  const cached = getFromCache(cacheKey)
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: getResponseHeaders(DNS_MESSAGE_TYPE),
    })
  }

  const data = await deduplicatedFetch(cacheKey, async () => {
    const response = await raceProviders((provider) =>
      fetch(provider.url, {
        method: "POST",
        headers: getPrivacyHeaders(),
        body: body,
      }),
    )
    return response.arrayBuffer()
  })

  const ttl = extractTTLFromResponse(data)
  setCache(cacheKey, data, ttl)

  return new Response(data, {
    status: 200,
    headers: getResponseHeaders(DNS_MESSAGE_TYPE),
  })
}

// Handle CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
    },
  })
}
