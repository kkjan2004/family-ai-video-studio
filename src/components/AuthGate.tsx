import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { LockKeyhole, Mail, ShieldCheck, Sparkles } from 'lucide-react'
import { supabase, supabaseConfigured, supabaseUrl } from '../lib/supabase'
import './auth.css'

type Props = { children: ReactNode }

export default function AuthGate({ children }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) {
      setChecking(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecking(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({ email: email.trim(), password })
        if (authError) throw authError
        setMessage(data.session
          ? 'Your account is ready. You are signed in.'
          : 'Registration received. Check your email to confirm your account, then sign in.')
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (authError) throw authError
      }
    } catch (err) {
      const detail = err && typeof err === 'object' ? err as Record<string, unknown> : {}
      console.error('Authentication diagnostic:', detail)
      const parts = [
        typeof detail.message === 'string' ? detail.message : err instanceof Error ? err.message : 'Authentication failed',
        typeof detail.code === 'string' ? `Code: ${detail.code}` : '',
        typeof detail.status === 'number' ? `HTTP: ${detail.status}` : '',
        typeof detail.details === 'string' ? `Details: ${detail.details}` : '',
        typeof detail.hint === 'string' ? `Hint: ${detail.hint}` : '',
        supabaseUrl ? `Auth endpoint: ${supabaseUrl}/auth/v1/signup` : 'Supabase project URL is invalid'
      ].filter(Boolean)
      setError(parts.join(' | '))
    } finally {
      setBusy(false)
    }
  }

  if (checking) return <div className="auth-loading">Opening your private studio…</div>

  if (session) {
    return <div className="authenticated-shell">
      <div className="session-bar">
        <span><ShieldCheck size={15} /> Signed in as {session.user.email}</span>
        <button onClick={() => supabase?.auth.signOut()}>Sign out</button>
      </div>
      {children}
    </div>
  }

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-brand"><span><Sparkles size={21} /></span><div><strong>Family AI Studio</strong><small>PRIVATE FAMILY WORKSPACE</small></div></div>
      <div className="auth-lock"><LockKeyhole size={22} /></div>
      <p className="auth-eyebrow">YOUR PRIVATE CREATIVE SPACE</p>
      <h1>{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1>
      <p className="auth-description">Sign in securely to access your family video workspace.</p>

      {!supabaseConfigured ? <div className="auth-notice">
        <strong>Supabase setup required</strong>
        <p>Add your Supabase Project URL and Publishable (anon) key to the hosting environment as <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>. Never use a service-role key here.</p>
      </div> : <form onSubmit={submit}>
        <label htmlFor="auth-email">EMAIL ADDRESS</label>
        <div className="auth-input"><Mail size={17} /><input id="auth-email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></div>
        <label htmlFor="auth-password">PASSWORD</label>
        <div className="auth-input"><LockKeyhole size={17} /><input id="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" /></div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        {message && <p className="auth-message" role="status">{message}</p>}
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in securely' : 'Create account'}</button>
      </form>}
      <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setMessage('') }}>
        {mode === 'login' ? 'New family member? Create an account' : 'Already registered? Sign in'}
      </button>
      <div className="auth-privacy"><ShieldCheck size={15} /> Your password is handled by Supabase Auth.</div>
    </section>
  </main>
}
