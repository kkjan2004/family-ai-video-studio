import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Clapperboard, Film, FolderOpen, Home, ImagePlus, Menu, Plus,
  Settings2, ShieldCheck, Sparkles, WandSparkles, X, Clock3,
  ChevronRight, Play, Users, Copy, LogOut, RefreshCw,
  LoaderCircle, CheckCircle2, AlertCircle, UploadCloud, UserPlus
} from 'lucide-react'
import { supabase } from './lib/supabase'

type Section = 'Home' | 'Create video' | 'My projects' | 'Family space' | 'Settings'
type Family = { id: string; name: string; created_at: string }
type FamilyMember = { user_id: string; role: string; joined_at: string }
type Project = { id: string; family_id: string; title: string; description: string | null; status: string; visibility: string; created_at: string }
type VideoJob = { id: string; project_id: string; mode: string; status: string; progress: number; prompt: string; quality_target: string; target_duration_seconds: number; created_at: string; error_message: string | null; output_asset_id: string | null }

const navigation: { label: Section; icon: typeof Home }[] = [
  { label: 'Home', icon: Home },
  { label: 'Create video', icon: WandSparkles },
  { label: 'My projects', icon: FolderOpen },
  { label: 'Family space', icon: Users },
  { label: 'Settings', icon: Settings2 }
]
const creationModes = [
  { title: 'Text to video', detail: 'Turn an idea or script into scenes.', icon: Clapperboard },
  { title: 'Image to video', detail: 'Bring your photos and artwork to life.', icon: ImagePlus },
  { title: 'Story to movie', detail: 'Build a movie from a complete story.', icon: Film }
]
const modeKey: Record<string, VideoJob['mode']> = {
  'Text to video': 'text_to_video',
  'Image to video': 'image_to_video',
  'Story to movie': 'story_to_movie'
}
const prettyDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function App() {
  const [section, setSection] = useState<Section>('Home')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('Text to video')
  const [userId, setUserId] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [family, setFamily] = useState<Family | null>(null)
  const [members, setMembers] = useState<FamilyMember[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [familyName, setFamilyName] = useState('My Family Workspace')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviteLink, setInviteLink] = useState('')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [quality, setQuality] = useState('1080p')
  const [duration, setDuration] = useState('600')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayKey, setGatewayKey] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerStatus, setProviderStatus] = useState<'checking' | 'connected' | 'not_connected' | 'unavailable'>('checking')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const isAdmin = useMemo(() => members.some(member => member.user_id === userId && ['owner', 'admin'].includes(member.role)), [members, userId])

  const loadWorkspace = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    setError('')
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!authData.user) return
      setUserId(authData.user.id)
      setUserEmail(authData.user.email ?? '')
      const { data: membershipRows, error: membershipError } = await supabase
        .from('family_members')
        .select('family_id, role, joined_at, families(id,name,created_at)')
        .eq('user_id', authData.user.id)
        .order('joined_at', { ascending: true })
      if (membershipError) throw membershipError
      const first = (membershipRows ?? [])[0] as unknown as { family_id: string; role: string; families: Family | Family[] | null } | undefined
      const selectedFamily = Array.isArray(first?.families) ? first.families[0] : first?.families
      if (!first || !selectedFamily) {
        setFamily(null); setMembers([]); setProjects([]); setJobs([])
        return
      }
      setFamily(selectedFamily)
      const [memberResult, projectResult] = await Promise.all([
        supabase.from('family_members').select('user_id,role,joined_at').eq('family_id', selectedFamily.id).order('joined_at'),
        supabase.from('projects').select('id,family_id,title,description,status,visibility,created_at').eq('family_id', selectedFamily.id).order('created_at', { ascending: false })
      ])
      if (memberResult.error) throw memberResult.error
      if (projectResult.error) throw projectResult.error
      setMembers((memberResult.data ?? []) as unknown as FamilyMember[])
      const loadedProjects = (projectResult.data ?? []) as Project[]
      setProjects(loadedProjects)
      if (loadedProjects.length) {
        const { data: jobRows, error: jobsError } = await supabase.from('video_jobs')
          .select('id,project_id,mode,status,progress,prompt,quality_target,target_duration_seconds,created_at,error_message,output_asset_id')
          .in('project_id', loadedProjects.map(project => project.id))
          .order('created_at', { ascending: false })
        if (jobsError) throw jobsError
        setJobs((jobRows ?? []) as VideoJob[])
      } else setJobs([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your family workspace.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    const client = supabase
    const active = jobs.some(job => ['queued','planning','generating','rendering'].includes(job.status))
    if (!client || !active || !projects.length) return
    const projectIdsKey = projects.map(project => project.id).join(',')
    const projectIds = projectIdsKey.split(',').filter(Boolean)
    const timer = window.setInterval(async () => {
      const [jobResult, projectResult] = await Promise.all([
        client.from('video_jobs').select('id,project_id,mode,status,progress,prompt,quality_target,target_duration_seconds,created_at,error_message,output_asset_id').in('project_id', projectIds).order('created_at', { ascending: false }),
        client.from('projects').select('id,family_id,title,description,status,visibility,created_at').eq('family_id', family?.id ?? '').order('created_at', { ascending: false })
      ])
      if (!jobResult.error && jobResult.data) setJobs(jobResult.data as VideoJob[])
      if (!projectResult.error && projectResult.data) setProjects(projectResult.data as Project[])
    }, 10000)
    return () => window.clearInterval(timer)
  }, [jobs.some(job => ['queued','planning','generating','rendering'].includes(job.status)), projects.map(project => project.id).join(','), family?.id])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invite')
    const client = supabase
    if (!token || !client) return
    let cancelled = false
    const accept = async () => {
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
        const tokenHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
        const { error: acceptError } = await client.rpc('accept_family_invitation', { invite_token_hash: tokenHash })
        if (acceptError) throw acceptError
        if (!cancelled) {
          window.history.replaceState({}, '', window.location.pathname)
          setNotice('You joined the family workspace successfully.')
          await loadWorkspace()
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Invitation could not be accepted.')
      }
    }
    void accept()
    return () => { cancelled = true }
  }, [loadWorkspace])

  const openCreator = (selectedMode = 'Text to video') => {
    setMode(selectedMode)
    setSection('Create video')
    setMobileMenu(false)
    setNotice('')
  }

  async function createFamily() {
    if (!supabase || !familyName.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { error: createError } = await supabase.rpc('create_my_family', { family_name: familyName.trim() })
      if (createError) throw createError
      setNotice('Your private family workspace is ready.')
      await loadWorkspace()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Family workspace could not be created.')
    } finally { setBusy(false) }
  }

  async function createInvitation() {
    if (!supabase || !family || !inviteEmail.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(byte => byte.toString(16).padStart(2, '0')).join('')
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
      const tokenHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
      const { error: inviteError } = await supabase.rpc('create_family_invitation', {
        target_family_id: family.id, invite_email: inviteEmail.trim(), invite_role: inviteRole, invite_token_hash: tokenHash
      })
      if (inviteError) throw inviteError
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('invite', token)
      setInviteLink(url.toString())
      setNotice('Invitation created. Share this private link only with the invited email address.')
      setInviteEmail('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invitation could not be created.')
    } finally { setBusy(false) }
  }

  async function queueVideo() {
    if (!supabase || !prompt.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      let activeFamily = family
      if (!activeFamily) {
        const { error: familyError } = await supabase.rpc('create_my_family', { family_name: familyName.trim() || 'My Family Workspace' })
        if (familyError) throw familyError
        await loadWorkspace()
        const { data: membershipRows, error: memberError } = await supabase.from('family_members')
          .select('family_id,families(id,name,created_at)').eq('user_id', userId)
        if (memberError) throw memberError
        const first = (membershipRows ?? [])[0] as unknown as { families: Family | Family[] | null } | undefined
        activeFamily = Array.isArray(first?.families) ? first.families[0] : first?.families ?? null
        if (!activeFamily) throw new Error('Family workspace was created but could not be loaded. Please refresh.')
        setFamily(activeFamily)
      }
      const title = prompt.trim().replace(/\s+/g, ' ').slice(0, 68) || 'Untitled video'
      const { data: project, error: projectError } = await supabase.from('projects').insert({
        family_id: activeFamily.id, created_by: userId, title, description: prompt.trim().slice(0, 500), status: 'queued', visibility: 'family'
      }).select('id').single()
      if (projectError) throw projectError
      if (imageFile && mode === 'Image to video') {
        const safeName = imageFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const storagePath = activeFamily.id + '/' + project.id + '/' + crypto.randomUUID() + '-' + safeName
        const { error: uploadError } = await supabase.storage.from('family-projects').upload(storagePath, imageFile, { contentType: imageFile.type, upsert: false })
        if (uploadError) throw uploadError
        const { error: assetError } = await supabase.from('project_assets').insert({
          project_id: project.id, uploaded_by: userId, asset_type: 'image', storage_path: storagePath,
          file_name: imageFile.name, mime_type: imageFile.type, file_size: imageFile.size
        })
        if (assetError) throw assetError
      }
      const { data: job, error: jobError } = await supabase.from('video_jobs').insert({
        project_id: project.id, requested_by: userId, mode: modeKey[mode], prompt: prompt.trim(),
        target_duration_seconds: Number(duration), aspect_ratio: aspectRatio, quality_target: quality
      }).select('id').single()
      if (jobError) throw jobError
      setNotice('Video job saved to your private queue. AI generation will start when the secure rendering worker and provider credentials are configured.')
      setPrompt('')
      setImageFile(null)
      await loadWorkspace()
      setSection('My projects')
      if (job?.id) setNotice('Video job ' + job.id.slice(0, 8) + ' is queued. The rendering worker is the remaining activation step.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The video job could not be saved.')
    } finally { setBusy(false) }
  }

  async function refreshProviderStatus() {
    const workerUrl = import.meta.env.VITE_WORKER_API_URL?.trim().replace(/\/+$/, '')
    if (!supabase || !workerUrl) { setProviderStatus('unavailable'); return }
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Sign in required')
      const response = await fetch(workerUrl + '/api/provider-connection', { headers: { authorization: 'Bearer ' + accessToken } })
      if (!response.ok) throw new Error('Provider status unavailable')
      const payload = await response.json() as { configured?: boolean }
      setProviderStatus(payload.configured ? 'connected' : 'not_connected')
    } catch {
      setProviderStatus('unavailable')
    }
  }

  async function saveProviderConnection() {
    const workerUrl = import.meta.env.VITE_WORKER_API_URL?.trim().replace(/\/$/, '')
    if (!supabase || !workerUrl || !gatewayUrl.trim() || !gatewayKey.trim()) { setError('Worker URL, FreeLLMAPI base URL and your personal API key are required.'); return }
    setProviderSaving(true); setError(''); setNotice('')
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Please sign in again.')
      const response = await fetch(workerUrl + '/api/provider-connection', { method: 'POST', headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: gatewayUrl.trim(), apiKey: gatewayKey.trim(), model: 'auto' }) })
      const payload = await response.json() as { ok?: boolean; message?: string; error?: string }
      if (!response.ok) throw new Error(payload.error || 'Provider connection could not be saved.')
      setGatewayKey(''); setProviderStatus('connected'); setNotice(payload.message || 'Your personal provider connection was saved securely.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Provider connection could not be saved.') }
    finally { setProviderSaving(false) }
  }

  async function downloadJob(job: VideoJob) {
    if (!supabase || !job.output_asset_id) return
    setError('')
    try {
      const { data: asset, error: assetError } = await supabase.from('project_assets').select('storage_path,file_name').eq('id', job.output_asset_id).single()
      if (assetError) throw assetError
      const { data: signed, error: signedError } = await supabase.storage.from('family-projects').createSignedUrl(asset.storage_path, 300, { download: asset.file_name })
      if (signedError) throw signedError
      window.location.assign(signed.signedUrl)
    } catch (err) { setError(err instanceof Error ? err.message : 'Video download link could not be created.') }
  }

  async function deleteProject(projectId: string) {
    if (!supabase || !window.confirm('Delete this project and its scenes, assets and jobs?')) return
    setBusy(true); setError('')
    try {
      const { error: deleteError } = await supabase.from('projects').delete().eq('id', projectId)
      if (deleteError) throw deleteError
      await loadWorkspace()
      setNotice('Project deleted.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Project could not be deleted.') }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (section === 'Settings') void refreshProviderStatus()
  }, [section])

  const statusLabel = (status: string) => status.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase())

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Play size={19} fill="currentColor" /></div>
          <div><strong>Family Studio</strong><span>PRIVATE WORKSPACE</span></div>
          <button className="icon-button close-menu" onClick={() => setMobileMenu(false)} aria-label="Close menu"><X /></button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>{navigation.map(({ label, icon: Icon }) => (
          <button key={label} className={`nav-item ${section === label ? 'active' : ''}`} onClick={() => { setSection(label); setMobileMenu(false) }}>
            <Icon size={18} /><span>{label}</span>{label === 'Family space' && <span className="nav-soon">{family ? members.length + ' MEMBERS' : 'SETUP'}</span>}
          </button>
        ))}</nav>
        <div className="sidebar-bottom">
          <div className="privacy-card"><ShieldCheck size={19} /><div><strong>Family privacy</strong><span>Separate accounts and private project access.</span></div></div>
          <div className="profile"><div className="avatar">{(userEmail[0] ?? 'F').toUpperCase()}</div><div><strong>{userEmail || 'Signed-in member'}</strong><span>{isAdmin ? 'Owner / Admin' : 'Family member'}</span></div><button className="icon-button profile-signout" onClick={() => supabase?.auth.signOut()} aria-label="Sign out"><LogOut size={16} /></button></div>
        </div>
      </aside>

      {mobileMenu && <button className="scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu /></button>
          <div className="breadcrumb">Family Studio <ChevronRight size={15} /> <span>{section}</span></div>
          <div className="top-status"><span className="status-dot" /> Private workspace</div>
        </header>

        {(notice || error) && <div className={`app-alert ${error ? 'alert-error' : 'alert-success'}`} role="status">
          {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}<span>{error || notice}</span>
          <button className="icon-button" onClick={() => { setError(''); setNotice('') }} aria-label="Dismiss"><X size={15} /></button>
        </div>}

        {loading && <div className="page-content loading-state"><LoaderCircle className="spin" /> Loading your private workspace…</div>}

        {!loading && section === 'Home' && <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><Sparkles size={14} /> YOUR CREATIVE SPACE</div><h1>Make something<br /><em>remarkable.</em></h1><p>Your family’s ideas, stories, and memories — brought to life with AI.</p></div>
            <div className="welcome-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-play"><Play size={36} fill="currentColor" /></div><Sparkles className="art-spark spark-one" /><Sparkles className="art-spark spark-two" /></div>
          </section>
          <section className="section-block">
            <div className="section-heading"><div><span className="eyebrow">START CREATING</span><h2>What would you like to make?</h2></div><span className="muted">Choose a workflow</span></div>
            <div className="mode-grid">{creationModes.map(({ title, detail, icon: Icon }) => <button className="mode-card" key={title} onClick={() => openCreator(title)}><div className="mode-icon"><Icon size={21} /></div><strong>{title}</strong><span>{detail}</span><div className="mode-arrow"><ChevronRight size={18} /></div></button>)}</div>
          </section>
          <section className="section-block lower-grid">
            <div className="panel quick-panel"><div className="section-heading"><div><span className="eyebrow">QUICK START</span><h2>Start with an idea</h2></div><WandSparkles size={20} /></div><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="A little idea can become a big story..." rows={3} /><button className="primary-button" onClick={() => openCreator('Text to video')}><Plus size={17} /> Create a video <ChevronRight size={17} /></button></div>
            <div className="panel projects-panel"><div className="section-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h2>Recent projects</h2></div><button className="text-button" onClick={() => setSection('My projects')}>View all <ChevronRight size={15} /></button></div>
              {projects.length ? <div className="mini-project-list">{projects.slice(0,3).map(project => <div className="mini-project" key={project.id}><Film size={18} /><div><strong>{project.title}</strong><span>{statusLabel(project.status)} · {prettyDate(project.created_at)}</span></div></div>)}</div> : <div className="empty-state"><div className="empty-icon"><Film size={23} /></div><strong>Your next story starts here</strong><span>Your saved projects will appear here.</span></div>}
            </div>
          </section>
          {!family && <div className="setup-strip"><Users size={17} /><span>Create your family workspace to save projects and invite family members.</span><button className="text-button" onClick={() => setSection('Family space')}>Set up <ChevronRight size={14} /></button></div>}
          <div className="footnote"><ShieldCheck size={15} /> Private family workspace · {projects.length} projects · {members.length} family members</div>
        </div>}

        {!loading && section === 'Create video' && <div className="page-content inner-page">
          <div className="eyebrow"><WandSparkles size={14} /> CREATION WORKSHOP</div><h1>Create your <em>next video.</em></h1><p className="page-lead">Build a project and queue it for secure AI rendering.</p>
          <div className="panel creator-panel">
            <label className="field-label">CREATION TYPE</label><div className="choice-row">{creationModes.map(item => <button key={item.title} className={`choice ${mode === item.title ? 'selected' : ''}`} onClick={() => setMode(item.title)}>{item.title}</button>)}</div>
            <label className="field-label" htmlFor="video-prompt">YOUR IDEA OR STORY</label><textarea id="video-prompt" className="large-textarea" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Describe your video, characters, scenes, visual style, and mood..." rows={7} />
            {mode === 'Image to video' && <div className="upload-field"><label className="field-label" htmlFor="source-image">SOURCE IMAGE (OPTIONAL)</label><label className="upload-drop" htmlFor="source-image"><UploadCloud size={20} /><span>{imageFile ? imageFile.name : 'Choose an image from your phone'}</span><small>JPG, PNG or WebP</small></label><input id="source-image" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setImageFile(event.target.files?.[0] ?? null)} /></div>}
            <div className="creator-options">
              <div><label className="field-label" htmlFor="quality">VIDEO QUALITY</label><select id="quality" value={quality} onChange={event => setQuality(event.target.value)}><option value="1080p">1080p target</option><option value="720p">720p target</option></select><small>Provider support determines native or upscaled output.</small></div>
              <div><label className="field-label" htmlFor="duration">PROJECT LENGTH</label><select id="duration" value={duration} onChange={event => setDuration(event.target.value)}><option value="30">30 seconds</option><option value="60">1 minute</option><option value="180">3 minutes</option><option value="300">5 minutes</option><option value="600">10 minutes (default)</option><option value="900">15 minutes</option><option value="1800">30 minutes</option><option value="3600">60 minutes</option></select><small>Long videos are assembled from short generated clips.</small></div>
              <div><label className="field-label" htmlFor="aspect">ASPECT RATIO</label><select id="aspect" value={aspectRatio} onChange={event => setAspectRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:5</option></select><small>Choose landscape, Shorts, square or portrait.</small></div>
              <div><span className="field-label">WORKSPACE</span><strong>{family?.name ?? 'Will create your family workspace'}</strong><small>Private project storage with family permissions.</small></div>
            </div>
            <button className="primary-button wide-button" disabled={!prompt.trim() || busy} onClick={() => void queueVideo()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} Save project & queue video <ChevronRight size={17} /></button>
            <p className="helper-text">This creates a real private project and queued job. Actual video generation starts after the secure rendering worker and authorized provider credentials are connected.</p>
          </div>
        </div>}

        {!loading && section === 'My projects' && <div className="page-content inner-page"><div className="eyebrow"><FolderOpen size={14} /> YOUR LIBRARY</div><h1>My <em>projects.</em></h1><p className="page-lead">Private projects and family-shared video work.</p>
          <div className="project-list">{projects.length ? projects.map(project => {
            const projectJobs = jobs.filter(job => job.project_id === project.id)
            const latestJob = projectJobs[0]
            return <article className="project-card" key={project.id}><div className="project-icon"><Film size={22} /></div><div className="project-main"><strong>{project.title}</strong><span>{project.visibility === 'family' ? 'Family shared' : 'Private'} · {prettyDate(project.created_at)}</span>{latestJob && <div className="job-line"><span className={`job-status status-${latestJob.status}`}>{statusLabel(latestJob.status)}</span><span>{latestJob.progress}% · {latestJob.quality_target} · {Math.round(latestJob.target_duration_seconds / 60)} min</span></div>}{latestJob && <div className="progress-track"><span style={{ width: `${latestJob.progress}%` }} /></div>}{latestJob?.error_message && <small className="job-error">{latestJob.error_message}</small>}{latestJob?.status === 'completed' && <button className="text-button download-button" onClick={() => void downloadJob(latestJob)}><Film size={14} /> Download MP4</button>}</div><button className="icon-button delete-project" onClick={() => void deleteProject(project.id)} aria-label="Delete project"><X size={17} /></button></article>
          }) : <div className="panel empty-large"><div className="empty-icon"><Film size={28} /></div><h2>No projects yet</h2><p>Start a video and your saved projects will appear here.</p><button className="primary-button" onClick={() => openCreator()}><Plus size={17} /> Create your first video</button></div>}</div>
        </div>}

        {!loading && section === 'Family space' && <div className="page-content inner-page"><div className="eyebrow"><Users size={14} /> FAMILY WORKSPACE</div><h1>Made for your <em>family.</em></h1><p className="page-lead">Manage your private family workspace, individual accounts and invitations.</p>
          {!family ? <div className="panel family-create"><div className="empty-icon"><Users size={25} /></div><h2>Create your family workspace</h2><p>Become the owner, then invite your family members using their own accounts.</p><label className="field-label" htmlFor="family-name">FAMILY WORKSPACE NAME</label><input id="family-name" value={familyName} onChange={event => setFamilyName(event.target.value)} maxLength={80} placeholder="My Family Workspace" /><button className="primary-button" disabled={busy || familyName.trim().length < 2} onClick={() => void createFamily()}>{busy ? 'Creating…' : 'Create private workspace'} <ChevronRight size={16} /></button></div> : <>
            <div className="panel family-summary"><div><span className="eyebrow">ACTIVE WORKSPACE</span><h2>{family.name}</h2><span>{members.length} members · Created {prettyDate(family.created_at)}</span></div><button className="icon-button" onClick={() => void loadWorkspace()} aria-label="Refresh family"><RefreshCw size={17} /></button></div>
            <div className="panel feature-list member-list"><div className="section-heading"><div><span className="eyebrow">FAMILY MEMBERS</span><h2>People with access</h2></div><Users size={20} /></div>{members.map(member => <div key={member.user_id}><div className="member-avatar">{(member.user_id[0] ?? 'F').toUpperCase()}</div><div><strong>{member.user_id === userId ? userEmail : 'Family member'}</strong><span>{member.role} · Joined {prettyDate(member.joined_at)}</span></div><span className="member-role">{member.role}</span></div>)}</div>
            {isAdmin && <div className="panel invite-panel"><div className="section-heading"><div><span className="eyebrow">OWNER CONTROLS</span><h2>Invite a family member</h2></div><UserPlus size={20} /></div><label className="field-label" htmlFor="invite-email">MEMBER EMAIL ADDRESS</label><input id="invite-email" type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} placeholder="family.member@example.com" /><label className="field-label" htmlFor="invite-role">ACCESS ROLE</label><select id="invite-role" value={inviteRole} onChange={event => setInviteRole(event.target.value as 'member' | 'admin')}><option value="member">Member — create and manage own projects</option><option value="admin">Admin — manage family workspace</option></select><button className="primary-button" disabled={busy || !inviteEmail.includes('@')} onClick={() => void createInvitation()}>{busy ? 'Creating invitation…' : 'Create secure invitation'} <ChevronRight size={16} /></button>{inviteLink && <div className="invite-link"><span>{inviteLink}</span><button className="text-button" onClick={() => void navigator.clipboard?.writeText(inviteLink)}><Copy size={15} /> Copy link</button></div>}<p className="helper-text">Invitation links expire after 7 days and can only be accepted by the invited email address.</p></div>}
          </>}
        </div>}

        {!loading && section === 'Settings' && <div className="page-content inner-page"><div className="eyebrow"><Settings2 size={14} /> WORKSPACE SETTINGS</div><h1>Studio <em>settings.</em></h1><p className="page-lead">Privacy, account and generation preferences.</p><div className="panel settings-list"><div><span>Signed-in account</span><strong>{userEmail}</strong></div><div><span>Workspace</span><strong>{family?.name ?? 'Not created yet'}</strong></div><div><span>Workspace visibility</span><strong><ShieldCheck size={16} /> Private family workspace</strong></div><div><span>Default video length</span><strong>10 minutes</strong></div><div><span>Target output</span><strong>1080p where supported</strong></div><div><span>Rendering worker</span><strong className="pending"><Clock3 size={16} /> Awaiting server setup</strong></div><div><span>Service connection</span><strong>Supabase Auth & Database</strong></div></div><div className="panel provider-panel"><div className="section-heading"><div><span className="eyebrow">CONNECTION STATUS</span><h2>{providerStatus === 'connected' ? 'Provider connected' : providerStatus === 'not_connected' ? 'Provider not connected' : providerStatus === 'checking' ? 'Checking provider…' : 'Status unavailable'}</h2></div><span className={providerStatus === 'connected' ? 'status-pill success' : 'status-pill pending'}>{providerStatus === 'connected' ? 'READY' : providerStatus === 'not_connected' ? 'NOT SET' : 'CHECKING'}</span></div><div className="section-heading"><div><span className="eyebrow">AI PROVIDER</span><h2>Connect your own FreeLLMAPI</h2></div><Sparkles size={20} /></div>{import.meta.env.VITE_WORKER_API_URL ? <><label className="field-label" htmlFor="gateway-url">YOUR PUBLIC HTTPS GATEWAY URL (ENDS IN /v1)</label><input id="gateway-url" value={gatewayUrl} onChange={event => setGatewayUrl(event.target.value)} placeholder="https://your-freellmapi-host/v1" /><label className="field-label" htmlFor="gateway-key">YOUR PERSONAL FREE LLM API KEY</label><input id="gateway-key" type="password" autoComplete="off" value={gatewayKey} onChange={event => setGatewayKey(event.target.value)} placeholder="Paste your own gateway key" /><button className="primary-button" disabled={providerSaving || !gatewayUrl.trim() || !gatewayKey.trim()} onClick={() => void saveProviderConnection()}>{providerSaving ? 'Encrypting & saving…' : 'Save my secure provider connection'} <ChevronRight size={16} /></button><p className="helper-text">Each family member connects their own permitted account. Keys are sent only to your HTTPS worker and encrypted before storage; they are never placed in the browser database or shared with other members.</p></> : <p className="helper-text">The secure rendering worker URL is not configured yet. Deploy the worker in the /worker folder, then set VITE_WORKER_API_URL in the frontend build environment.</p>}</div><button className="secondary-button" onClick={() => void loadWorkspace()}><RefreshCw size={16} /> Refresh workspace data</button></div>}
      </main>
    </div>
  )
}
export default App
