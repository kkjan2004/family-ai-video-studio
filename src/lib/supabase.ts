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
    // Only the project origin belongs here. Remove accidental /rest/v1 or
    // /auth/v1 suffixes so SDK endpoints are always built from the root.
    return parsed.origin
  } catch {
    return null
  }
}

export const supabaseUrl = normalizeProjectUrl(rawSupabaseUrl)
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null
