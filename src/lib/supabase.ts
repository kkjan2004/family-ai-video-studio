import { createClient } from '@supabase/supabase-js'

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function normalizeProjectUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    const isSupabaseProjectHost = parsed.hostname.endsWith('.supabase.co')
    const isLocalhost = parsed.hostname === 'localhost'
    if (parsed.protocol !== 'https:' && !isLocalhost) return null
    if (!isSupabaseProjectHost && !isLocalhost) return null
    if (parsed.search || parsed.hash || parsed.username || parsed.password) return null
    return parsed.origin
  } catch {
    return null
  }
}

export const supabaseUrl = normalizeProjectUrl(rawSupabaseUrl)
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export type FailedRequestDiagnostic = {
  url: string
  method: string
  status: number
  response: string
}

let lastFailedRequest: FailedRequestDiagnostic | null = null
export function getLastFailedRequest(): FailedRequestDiagnostic | null {
  return lastFailedRequest
}

async function diagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestUrl = input instanceof Request ? input.url : String(input)
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const response = await fetch(input, init)
  if (!response.ok) {
    let responseBody = ''
    try { responseBody = (await response.clone().text()).slice(0, 1800) }
    catch { responseBody = '(response body could not be read)' }
    lastFailedRequest = { url: requestUrl, method, status: response.status, response: responseBody || '(empty response body)' }
    console.error('[SUPABASE ACTUAL FAILED REQUEST]', lastFailedRequest)
  }
  return response
}

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      global: { fetch: diagnosticFetch },
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null
