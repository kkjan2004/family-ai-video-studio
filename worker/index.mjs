import http from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
  if (req.method === 'POST' && req.url === '/api/provider-connection') {
    try {
      const user = await authenticate(req)
      const body = await readJson(req)
      const base = new URL(String(body.baseUrl || ''))
      if (base.protocol !== 'https:') throw new Error('Use a public HTTPS FreeLLMAPI address.')
      if (!String(body.apiKey || '').trim() || String(body.apiKey).length > 4096) throw new Error('Enter a valid API key.')
      const baseUrl = base.toString().replace(/\/$/, '')
      if (!baseUrl.endsWith('/v1')) throw new Error('Base URL must end with /v1 (example: https://your-host/v1).')
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
async function processJob(job) {
  const workDir = await mkdtemp(join(tmpdir(), 'family-video-'))
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
    const clipSeconds = 6
    const clipCount = Math.ceil(job.target_duration_seconds / clipSeconds)
    const normalized = []
    await updateJob(job.id, { status: 'generating', progress: 2, provider: 'freellmapi' })
    await event(job.id, 'started', `Preparing ${clipCount} short clips.`, 2)
    for (let index = 0; index < clipCount; index++) {
      const seconds = Math.min(clipSeconds, job.target_duration_seconds - index * clipSeconds)
      const scenePrompt = [
        job.prompt,
        `Shot ${index + 1} of ${clipCount}. Create a coherent cinematic sequence with consistent characters, clothing, locations, lighting and visual style. This shot should progress naturally from the previous shot. No captions, no watermarks.`,
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
      const portrait = job.aspect_ratio === '9:16' || job.aspect_ratio === '4:5'
      const width = portrait ? 1080 : 1920
      const height = portrait ? 1920 : 1080
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
    const outputPath = join(workDir, 'final.mp4')
    await run('ffmpeg', ['-y','-f','concat','-safe','0','-i',concatPath,'-c','copy','-movflags','+faststart',outputPath])
    const output = await readFile(outputPath)
    const storagePath = `${project.family_id}/${project.id}/renders/${job.id}.mp4`
    const { error: uploadError } = await supabase.storage.from('family-projects').upload(storagePath, output, { contentType: 'video/mp4', upsert: true })
    if (uploadError) throw uploadError
    const { data: asset, error: assetError } = await supabase.from('project_assets').insert({
      project_id: project.id, uploaded_by: job.requested_by, asset_type: 'render',
      storage_path: storagePath, file_name: `${project.title.slice(0, 80)}.mp4`,
      mime_type: 'video/mp4', file_size: output.length
    }).select('id').single()
    if (assetError) throw assetError
    await updateJob(job.id, { status: 'completed', progress: 100, output_asset_id: asset.id, completed_at: new Date().toISOString() })
    await event(job.id, 'completed', 'Your MP4 video is ready in My Projects.', 100)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : 'Video rendering failed.'
    await updateJob(job.id, { status: 'failed', error_message: message, completed_at: new Date().toISOString() }).catch(() => {})
    await event(job.id, 'failed', message).catch(() => {})
    console.error('Job failed:', job.id, message)
  } finally {
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
