import http from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createClient } from '@supabase/supabase-js'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PROVIDER_CREDENTIALS_ENCRYPTION_KEY']
for (const name of required) if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`)
const encryptionKey = Buffer.from(process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY, 'hex')
if (encryptionKey.length !== 32) throw new Error('PROVIDER_CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters.')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})
const port = Number(process.env.PORT || 8080)
const pollInterval = Math.max(3000, Number(process.env.POLL_INTERVAL_MS || 5000))
const appOrigin = process.env.APP_ORIGIN || ''

function encrypt(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}
function decrypt(value) {
  const [iv, tag, body] = value.split('.')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
}
function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number)
    const [a,b] = octets
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19))
  }
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('::ffff:') || value.startsWith('fc') || value.startsWith('fd')
    || value.startsWith('fe80:') || value.startsWith('ff')
}
async function validatePublicGateway(url) {
  if (url.protocol !== 'https:') throw new Error('Use a public HTTPS FreeLLMAPI address.')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local') || isIP(hostname)) {
    throw new Error('The gateway must use a public DNS hostname, not a local or IP address.')
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('The gateway hostname must resolve only to public IP addresses.')
  }
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 12000) throw new Error('Request body too large')
  }
  return JSON.parse(raw || '{}')
}
function cors(req, res) {
  const origin = req.headers.origin || ''
  if (appOrigin && origin === appOrigin) {
    res.setHeader('access-control-allow-origin', appOrigin)
    res.setHeader('vary', 'Origin')
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
}
async function authenticate(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('Sign in required')
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) throw new Error('Your sign-in session is invalid or expired')
  return data.user
}
const server = http.createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'family-video-worker' })
  if (req.method === 'GET' && req.url === '/api/provider-connection') {
    try {
      const user = await authenticate(req)
      const { data, error } = await supabase.from('provider_connections')
        .select('is_enabled')
        .eq('user_id', user.id)
        .eq('provider', 'freellmapi')
        .maybeSingle()
      if (error) throw error
      return send(res, 200, { ok: true, configured: Boolean(data?.is_enabled) })
    } catch (error) {
      return send(res, 401, { error: error instanceof Error ? error.message : 'Could not read provider status.' })
    }
  }
  if (req.method === 'POST' && req.url === '/api/provider-connection') {
    try {
      const user = await authenticate(req)
      const body = await readJson(req)
      const base = new URL(String(body.baseUrl || ''))
      await validatePublicGateway(base)
      if (base.username || base.password || base.search || base.hash) throw new Error('Gateway URL cannot contain credentials, query parameters or fragments.')
      if (!String(body.apiKey || '').trim() || String(body.apiKey).length > 4096) throw new Error('Enter a valid API key.')
      const baseUrl = base.toString().replace(/\/$/, '')
      if (!baseUrl.endsWith('/v1')) throw new Error('Base URL must end with /v1 (example: https://your-host/v1).')
      const verification = await fetch(baseUrl + '/models?available=true', { headers: { authorization: 'Bearer ' + String(body.apiKey).trim() }, signal: AbortSignal.timeout(20000) })
      if (!verification.ok) throw new Error('FreeLLMAPI connection check failed with HTTP ' + verification.status + '.')
      const { error } = await supabase.from('provider_connections').upsert({
        user_id: user.id,
        provider: 'freellmapi',
        base_url: baseUrl,
        model: String(body.model || 'auto').slice(0, 120),
        encrypted_api_key: encrypt(String(body.apiKey).trim()),
        is_enabled: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,provider' })
      if (error) throw error
      return send(res, 200, { ok: true, message: 'Your personal provider connection was saved securely.' })
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : 'Could not save provider connection.' })
    }
  }
  return send(res, 404, { error: 'Not found' })
})

function outputSize(aspectRatio, quality) {
  const scale = quality === '720p' ? 0.6666667 : 1
  const base = aspectRatio === '9:16' ? [1080,1920] : aspectRatio === '1:1' ? [1080,1080] : aspectRatio === '4:5' ? [1080,1350] : [1920,1080]
  return base.map(value => Math.round(value * scale / 2) * 2)
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString().slice(-4000) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `${command} exited with ${code}`)))
  })
}
async function event(jobId, type, message, progress = null) {
  await supabase.from('video_job_events').insert({ job_id: jobId, event_type: type, message, progress })
}
async function updateJob(jobId, values) {
  const { error } = await supabase.from('video_jobs').update(values).eq('id', jobId)
  if (error) throw error
}
async function generateClip({ baseUrl, apiKey, model, prompt, duration, aspectRatio, imageUrl }) {
  const response = await fetch(baseUrl + '/videos/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || 'auto',
      prompt,
      duration,
      aspect_ratio: aspectRatio,
      ...(imageUrl ? { image: imageUrl } : {})
    }),
    signal: AbortSignal.timeout(300000)
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200)
    throw new Error(`Video provider returned HTTP ${response.status}: ${detail}`)
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
    const detail = (await response.text()).slice(0, 1200)
    throw new Error('Provider did not return an MP4 video: ' + detail)
  }
  return Buffer.from(await response.arrayBuffer())
}
async function generateSpeech({ baseUrl, apiKey, text, voice }) {
  const response = await fetch(baseUrl + '/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_MODEL || 'tts-1', input: text, voice: voice || 'alloy', response_format: 'mp3' }),
    signal: AbortSignal.timeout(120000)
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000)
    throw new Error('AI narration is not available from this gateway (HTTP ' + response.status + '). Disable AI narration or configure a compatible speech model. ' + detail)
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('audio') && !contentType.includes('octet-stream')) {
    throw new Error('The speech endpoint did not return an audio file. Disable AI narration or check your gateway TTS support.')
  }
  return Buffer.from(await response.arrayBuffer())
}
async function downloadPrivateAsset(storagePath, workDir, filename) {
  const { data, error } = await supabase.storage.from('family-projects').createSignedUrl(storagePath, 600)
  if (error || !data?.signedUrl) throw new Error('Could not create a private audio download link.')
  const response = await fetch(data.signedUrl, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error('Could not download the private background music file.')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > 50 * 1024 * 1024) throw new Error('Background music exceeds the 50 MB file limit.')
  const path = join(workDir, filename)
  await writeFile(path, buffer)
  return path
}
async function planStoryboard({ baseUrl, apiKey, model, prompt, durationSeconds }) {
  const count = Math.min(60, Math.max(1, Math.ceil(durationSeconds / 30)))
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || 'auto',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a film storyboard director. Return valid JSON only with a scenes array. Each scene must have title, visual_prompt, and narration. Keep characters, costumes, setting and visual style consistent. Make each scene visually filmable and sequential.' },
          { role: 'user', content: `Create exactly ${count} sequential storyboard scenes for this ${durationSeconds}-second video. The overall concept is: ${prompt}. Return {"scenes":[{"title":"...","visual_prompt":"...","narration":"..."}]}.` }
        ]
      }),
      signal: AbortSignal.timeout(90000)
    })
    if (!response.ok) throw new Error('Storyboard planner returned HTTP ' + response.status)
    const payload = await response.json()
    const content = payload.choices?.[0]?.message?.content
    const parsed = JSON.parse(typeof content === 'string' ? content : JSON.stringify(content))
    if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) throw new Error('Storyboard response had no scenes')
    return parsed.scenes.slice(0, count).map((scene, index) => ({
      sort_order: index,
      title: String(scene.title || `Scene ${index + 1}`).slice(0, 160),
      visual_prompt: String(scene.visual_prompt || prompt).slice(0, 4000),
      narration: String(scene.narration || '').slice(0, 2000),
      duration_seconds: Math.min(120, Math.ceil(durationSeconds / count)),
      style: 'AI storyboard'
    }))
  } catch (error) {
    console.warn('Storyboard planning fallback:', error instanceof Error ? error.message : error)
    return [{
      sort_order: 0,
      title: 'Main sequence',
      visual_prompt: prompt,
      narration: '',
      duration_seconds: Math.min(120, durationSeconds),
      style: 'Prompt fallback'
    }]
  }
}
async function processJob(job) {
  const workDir = await mkdtemp(join(tmpdir(), 'family-video-'))
  const heartbeat = setInterval(() => {
    void supabase.from('video_jobs')
      .update({ lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
      .eq('id', job.id)
      .in('status', ['planning', 'generating', 'rendering'])
      .then(({ error }) => { if (error) console.error('Job lease heartbeat failed:', job.id, error.message) })
  }, 60_000)
  try {
    const [{ data: project, error: projectError }, { data: connection, error: connectionError }] = await Promise.all([
      supabase.from('projects').select('id,family_id,title').eq('id', job.project_id).single(),
      supabase.from('provider_connections').select('base_url,model,encrypted_api_key').eq('user_id', job.requested_by).eq('provider', 'freellmapi').eq('is_enabled', true).single()
    ])
    if (projectError) throw projectError
    if (connectionError || !connection) throw new Error('This member has not connected their own FreeLLMAPI account yet.')
    const apiKey = decrypt(connection.encrypted_api_key)
    const { data: imageAsset } = await supabase.from('project_assets').select('storage_path').eq('project_id', job.project_id).eq('asset_type', 'image').order('created_at', { ascending: true }).limit(1).maybeSingle()
    let imageUrl = null
    if (imageAsset?.storage_path) {
      const { data: signed, error } = await supabase.storage.from('family-projects').createSignedUrl(imageAsset.storage_path, 86400)
      if (!error) imageUrl = signed?.signedUrl ?? null
    }
    const storyboard = await planStoryboard({ baseUrl: connection.base_url, apiKey, model: connection.model, prompt: job.prompt, durationSeconds: job.target_duration_seconds })
    await supabase.from('project_scenes').delete().eq('project_id', job.project_id)
    const { error: sceneError } = await supabase.from('project_scenes').insert(storyboard.map(scene => ({ ...scene, project_id: job.project_id })))
    if (sceneError) throw sceneError
    const clipSeconds = 6
    const clipCount = Math.ceil(job.target_duration_seconds / clipSeconds)
    const normalized = []
    const narrationSegments = []
    if (job.narration_enabled) {
      await event(job.id, 'audio_planning', 'Preparing AI voice narration for the storyboard.', 2)
      for (let index = 0; index < storyboard.length; index++) {
        const scene = storyboard[index]
        const sceneDuration = index === storyboard.length - 1
          ? Math.max(1, job.target_duration_seconds - storyboard.slice(0, index).reduce((sum, item) => sum + item.duration_seconds, 0))
          : Math.min(scene.duration_seconds, Math.max(1, job.target_duration_seconds - storyboard.slice(0, index).reduce((sum, item) => sum + item.duration_seconds, 0)))
        const audioPath = join(workDir, 'narration-' + String(index).padStart(3, '0') + '.wav')
        if (scene.narration.trim()) {
          const speech = await generateSpeech({ baseUrl: connection.base_url, apiKey, text: scene.narration, voice: job.narration_voice })
          const speechPath = join(workDir, 'speech-' + String(index).padStart(3, '0') + '.mp3')
          await writeFile(speechPath, speech)
          await run('ffmpeg', ['-y','-i',speechPath,'-af',`apad,atrim=0:${sceneDuration},asetpts=N/SR/TB`,'-ar','44100','-ac','2','-c:a','pcm_s16le',audioPath])
        } else {
          await run('ffmpeg', ['-y','-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-t',String(sceneDuration),'-c:a','pcm_s16le',audioPath])
        }
        narrationSegments.push(audioPath)
      }
    }
    let backgroundMusicPath = null
    if (job.background_music_path) {
      backgroundMusicPath = await downloadPrivateAsset(job.background_music_path, workDir, 'background-music')
    }
    await supabase.from('projects').update({ status: 'processing' }).eq('id', project.id)
    await updateJob(job.id, { status: 'generating', progress: 2, provider: 'freellmapi' })
    await event(job.id, 'started', `Preparing ${clipCount} short clips.`, 2)
    for (let index = 0; index < clipCount; index++) {
      const seconds = Math.min(clipSeconds, job.target_duration_seconds - index * clipSeconds)
      const scene = storyboard[Math.min(Math.floor(index / 5), storyboard.length - 1)]
      const scenePrompt = [
        job.prompt,
        `Scene: ${scene.title}. ${scene.visual_prompt}`,
        `Shot ${index + 1} of ${clipCount}. Continue this scene coherently, keeping characters, clothing, locations, lighting and visual style consistent. No captions, no watermarks.`,
        `Aspect ratio ${job.aspect_ratio}. Target quality ${job.quality_target} where supported.`
      ].join('\n\n')
      const rawPath = join(workDir, `raw-${String(index).padStart(4, '0')}.mp4`)
      const normalizedPath = join(workDir, `clip-${String(index).padStart(4, '0')}.mp4`)
      const buffer = await generateClip({
        baseUrl: connection.base_url,
        apiKey,
        model: connection.model,
        prompt: scenePrompt,
        duration: seconds,
        aspectRatio: job.aspect_ratio,
        imageUrl: index === 0 ? imageUrl : null
      })
      await writeFile(rawPath, buffer)
      const [width, height] = outputSize(job.aspect_ratio, job.quality_target)
      await run('ffmpeg', ['-y','-i',rawPath,'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30`,'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an',normalizedPath])
      normalized.push(normalizedPath)
      const progress = Math.min(90, Math.round(((index + 1) / clipCount) * 88) + 2)
      await updateJob(job.id, { progress })
      await event(job.id, 'clip_completed', `Generated clip ${index + 1} of ${clipCount}.`, progress)
    }
    await updateJob(job.id, { status: 'rendering', progress: 92 })
    await event(job.id, 'rendering', 'Combining generated clips into the final MP4.', 92)
    const concatPath = join(workDir, 'clips.txt')
    await writeFile(concatPath, normalized.map(path => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'))
    const silentPath = join(workDir, 'silent.mp4')
    const outputPath = join(workDir, 'final.mp4')
    const targetBitrate = Math.max(160000, Math.floor((47 * 1024 * 1024 * 8 * 0.9) / job.target_duration_seconds))
    await run('ffmpeg', ['-y','-f','concat','-safe','0','-i',concatPath,'-c:v','libx264','-preset','veryfast','-b:v',String(targetBitrate),'-maxrate',String(targetBitrate),'-bufsize',String(targetBitrate * 2),'-pix_fmt','yuv420p','-an','-movflags','+faststart',silentPath])
    let finalPath = silentPath
    if (narrationSegments.length) {
      const narrationList = join(workDir, 'narration.txt')
      await writeFile(narrationList, narrationSegments.map(path => `file '${path.replace(/'/g, "'\\\\''")}'`).join('\n'))
      const narrationPath = join(workDir, 'narration.wav')
      await run('ffmpeg', ['-y','-f','concat','-safe','0','-i',narrationList,'-ar','44100','-ac','2','-c:a','pcm_s16le',narrationPath])
      const args = ['-y','-i',silentPath,'-i',narrationPath]
      if (backgroundMusicPath) args.push('-stream_loop','-1','-i',backgroundMusicPath)
      if (backgroundMusicPath) {
        args.push('-filter_complex','[1:a]volume=1.0[narr];[2:a]volume=0.18[music];[narr][music]amix=inputs=2:duration=first:dropout_transition=2[aout]','-map','0:v:0','-map','[aout]')
      } else {
        args.push('-filter_complex','[1:a]volume=1.0[aout]','-map','0:v:0','-map','[aout]')
      }
      args.push('-c:v','copy','-c:a','aac','-b:a','128k','-t',String(job.target_duration_seconds),'-movflags','+faststart',outputPath)
      await run('ffmpeg', args)
      finalPath = outputPath
    } else if (backgroundMusicPath) {
      await run('ffmpeg', ['-y','-i',silentPath,'-stream_loop','-1','-i',backgroundMusicPath,'-filter_complex','[1:a]volume=0.22[aout]','-map','0:v:0','-map','[aout]','-c:v','copy','-c:a','aac','-b:a','128k','-t',String(job.target_duration_seconds),'-movflags','+faststart',outputPath])
      finalPath = outputPath
    }
    const output = await readFile(finalPath)
    if (output.length > 50 * 1024 * 1024) throw new Error('Final MP4 exceeds the current 50 MB storage limit. Use a shorter video or upgrade storage before rendering longer videos.')
    const storagePath = `${project.family_id}/${project.id}/renders/${job.id}.mp4`
    const { error: uploadError } = await supabase.storage.from('family-projects').upload(storagePath, output, { contentType: 'video/mp4', upsert: true })
    if (uploadError) throw uploadError
    const { data: asset, error: assetError } = await supabase.from('project_assets').insert({
      project_id: project.id, uploaded_by: job.requested_by, asset_type: 'render',
      storage_path: storagePath, file_name: `${project.title.slice(0, 80)}.mp4`,
      mime_type: 'video/mp4', file_size: output.length
    }).select('id').single()
    if (assetError) throw assetError
    await updateJob(job.id, { status: 'completed', progress: 100, output_asset_id: asset.id, completed_at: new Date().toISOString(), lease_expires_at: null })
    await supabase.from('projects').update({ status: 'completed' }).eq('id', project.id)
    await event(job.id, 'completed', 'Your MP4 video is ready in My Projects.', 100)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : 'Video rendering failed.'
    await updateJob(job.id, { status: 'failed', error_message: message, completed_at: new Date().toISOString(), lease_expires_at: null }).catch(() => {})
    if (job.project_id) await supabase.from('projects').update({ status: 'failed' }).eq('id', job.project_id).catch(() => {})
    await event(job.id, 'failed', message).catch(() => {})
    console.error('Job failed:', job.id, message)
  } finally {
    clearInterval(heartbeat)
    await rm(workDir, { recursive: true, force: true })
  }
}
let working = false
async function poll() {
  if (working) return
  working = true
  try {
    const { data, error } = await supabase.rpc('claim_next_video_job')
    if (error) throw error
    const job = Array.isArray(data) ? data[0] : data
    if (job) await processJob(job)
  } catch (error) {
    console.error('Worker poll failed:', error)
  } finally {
    working = false
  }
}
server.listen(port, () => {
  console.log(`Family Video Worker listening on :${port}`)
  void poll()
  setInterval(() => void poll(), pollInterval)
})
