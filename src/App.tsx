import { useState } from 'react'
import {
  Clapperboard, Film, FolderOpen, Home, ImagePlus, Menu, Plus,
  Settings2, ShieldCheck, Sparkles, WandSparkles, X, Clock3,
  ChevronRight, Play, Users
} from 'lucide-react'

type Section = 'Home' | 'Create video' | 'My projects' | 'Family space' | 'Settings'

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

function App() {
  const [section, setSection] = useState<Section>('Home')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('Text to video')

  const openCreator = (selectedMode = 'Text to video') => {
    setMode(selectedMode)
    setSection('Create video')
    setMobileMenu(false)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Play size={19} fill="currentColor" /></div>
          <div><strong>Family Studio</strong><span>PRIVATE WORKSPACE</span></div>
          <button className="icon-button close-menu" onClick={() => setMobileMenu(false)} aria-label="Close menu"><X /></button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {navigation.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${section === label ? 'active' : ''}`} onClick={() => { setSection(label); setMobileMenu(false) }}>
              <Icon size={18} /><span>{label}</span>{label === 'Family space' && <span className="nav-soon">PRIVATE</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card"><ShieldCheck size={19} /><div><strong>Family privacy</strong><span>Your workspace is designed to stay private.</span></div></div>
          <div className="profile"><div className="avatar">O</div><div><strong>Workspace owner</strong><span>Owner account</span></div><Settings2 size={17} /></div>
        </div>
      </aside>

      {mobileMenu && <button className="scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu /></button>
          <div className="breadcrumb">Family Studio <ChevronRight size={15} /> <span>{section}</span></div>
          <div className="top-status"><span className="status-dot" /> Private workspace</div>
        </header>

        {section === 'Home' && <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><Sparkles size={14} /> YOUR CREATIVE SPACE</div><h1>Make something<br /><em>remarkable.</em></h1><p>Your family’s ideas, stories, and memories — brought to life with AI.</p></div>
            <div className="welcome-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-play"><Play size={36} fill="currentColor" /></div><Sparkles className="art-spark spark-one" /><Sparkles className="art-spark spark-two" /></div>
          </section>

          <section className="section-block">
            <div className="section-heading"><div><span className="eyebrow">START CREATING</span><h2>What would you like to make?</h2></div><span className="muted">Choose a workflow</span></div>
            <div className="mode-grid">
              {creationModes.map(({ title, detail, icon: Icon }) => <button className="mode-card" key={title} onClick={() => openCreator(title)}><div className="mode-icon"><Icon size={21} /></div><strong>{title}</strong><span>{detail}</span><div className="mode-arrow"><ChevronRight size={18} /></div></button>)}
            </div>
          </section>

          <section className="section-block lower-grid">
            <div className="panel quick-panel"><div className="section-heading"><div><span className="eyebrow">QUICK START</span><h2>Start with an idea</h2></div><WandSparkles size={20} /></div><textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="A little idea can become a big story..." rows={3} /><button className="primary-button" onClick={() => openCreator('Text to video')}><Plus size={17} /> Create a video <ChevronRight size={17} /></button></div>
            <div className="panel projects-panel"><div className="section-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h2>Recent projects</h2></div><button className="text-button" onClick={() => setSection('My projects')}>View all <ChevronRight size={15} /></button></div><div className="empty-state"><div className="empty-icon"><Film size={23} /></div><strong>Your next story starts here</strong><span>Your created videos will appear here.</span></div></div>
          </section>
          <div className="footnote"><ShieldCheck size={15} /> Private family workspace · Video generation will be enabled after secure backend setup.</div>
        </div>}

        {section === 'Create video' && <div className="page-content inner-page">
          <div className="eyebrow"><WandSparkles size={14} /> CREATION WORKSHOP</div><h1>Create your <em>next video.</em></h1><p className="page-lead">Choose a workflow and describe what you want to bring to life.</p>
          <div className="panel creator-panel"><label className="field-label">CREATION TYPE</label><div className="choice-row">{creationModes.map(item => <button key={item.title} className={`choice ${mode === item.title ? 'selected' : ''}`} onClick={() => setMode(item.title)}>{item.title}</button>)}</div><label className="field-label" htmlFor="video-prompt">YOUR IDEA OR STORY</label><textarea id="video-prompt" className="large-textarea" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe your video, characters, scenes, visual style, and mood..." rows={7} /><div className="creator-options"><div><span className="field-label">VIDEO QUALITY</span><strong>Up to 1080p target</strong><small>Actual quality depends on the selected provider.</small></div><div><span className="field-label">PROJECT LENGTH</span><strong>10 minutes default</strong><small>Long videos are assembled from shorter clips.</small></div></div><button className="primary-button wide-button" disabled={!prompt.trim()} onClick={() => alert('The secure generation service is not connected yet. Your idea is kept in this page only.') }><Sparkles size={17} /> Prepare video <ChevronRight size={17} /></button><p className="helper-text">Generation is not active yet. Secure sign-in, provider authorization, and the rendering worker must be connected first.</p></div>
        </div>}

        {section === 'My projects' && <div className="page-content inner-page"><div className="eyebrow"><FolderOpen size={14} /> YOUR LIBRARY</div><h1>My <em>projects.</em></h1><p className="page-lead">Your family’s video projects will be organized here.</p><div className="panel empty-large"><div className="empty-icon"><Film size={28} /></div><h2>No projects yet</h2><p>Start a new video and it will appear here when project storage is connected.</p><button className="primary-button" onClick={() => openCreator()}><Plus size={17} /> Create your first video</button></div></div>}

        {section === 'Family space' && <div className="page-content inner-page"><div className="eyebrow"><Users size={14} /> FAMILY WORKSPACE</div><h1>Made for your <em>family.</em></h1><p className="page-lead">Separate accounts, invitations, and project permissions will be managed here.</p><div className="panel feature-list"><div><ShieldCheck /><div><strong>Owner-managed access</strong><span>The owner will invite family members and assign roles.</span></div></div><div><Users /><div><strong>Individual accounts</strong><span>Each family member will sign in with their own account.</span></div></div><div><FolderOpen /><div><strong>Project permissions</strong><span>Share selected projects without exposing the entire workspace.</span></div></div><p className="helper-text">Family access becomes available after Supabase authentication and database security policies are configured.</p></div></div>}

        {section === 'Settings' && <div className="page-content inner-page"><div className="eyebrow"><Settings2 size={14} /> WORKSPACE SETTINGS</div><h1>Studio <em>settings.</em></h1><p className="page-lead">Your privacy and generation preferences.</p><div className="panel settings-list"><div><span>Workspace visibility</span><strong><ShieldCheck size={16} /> Private family workspace</strong></div><div><span>Default video length</span><strong>10 minutes</strong></div><div><span>Target output</span><strong>1080p where supported</strong></div><div><span>Generation status</span><strong className="pending"><Clock3 size={16} /> Setup pending</strong></div></div></div>}
      </main>
    </div>
  )
}

export default App
