import { createClient } from '@supabase/supabase-js'

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function normalizeProjectUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return null
    if (parsed.search || parsed.hash || parsed.username || parsed.password) return null
    const path = parsed.pathname.replace(/\/+$/, '')
    // Accept a mistakenly copied REST/Auth endpoint, but always initialize
    // Supabase from the project root so Auth requests go to /auth/v1/*.
    if (path === '' || path === '/rest/v1' || path === '/auth/v1') {
      parsed.pathname = ''
      return parsed.origin
    }
    return null
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
