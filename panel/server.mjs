import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { api, directory, listFiles, outgoing, requestFiles, revoke, saveArrivals, send } from './transfers.mjs'

process.umask(0o077)
await directory(outgoing)
await directory('/documents/Upload dai clienti')
const db = new DatabaseSync('/state/panel.sqlite')
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, link TEXT NOT NULL,
    credential TEXT NOT NULL, password TEXT NOT NULL, expires INTEGER NOT NULL,
    created INTEGER NOT NULL, poll_until INTEGER NOT NULL, next_poll INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0, warning TEXT
  );
  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES transfers(id),
    filename TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0, UNIQUE (request_id, filename)
  );
`)

const origins = new Set(['http://127.0.0.1:8787', 'http://localhost:8787'])
const hosts = new Set([...origins].map(url => new URL(url).host))
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
}
const staticAssets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/ui.js', 'ui.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'],
].map(async ([url, file, type]) => [url, { type, body: await readFile(new URL(file, import.meta.url)) }])))

function respond(response, status, body, type = 'application/json') {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': type + '; charset=utf-8' })
  response.end(type === 'application/json' ? JSON.stringify(body) : body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const bytes of request.iterator({ destroyOnReturn: false })) {
    size += bytes.length
    if (size > 128 * 1024) throw new Error('Selezione troppo grande')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

function remember(item) {
  db.prepare(`INSERT INTO transfers (id, kind, label, link, credential, password, expires, created, poll_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    item.id, item.kind, item.label, item.link, item.credential, item.password,
    item.expires, Date.now(), item.pollUntil ?? 0,
  )
}

async function status() {
  const config = await api.fetchConfig()
  const now = Date.now()
  const transfers = db.prepare(`
    SELECT id, kind, label,
      CASE WHEN closed = 0 AND expires > ? THEN link END AS link,
      CASE WHEN kind = 'send' AND closed = 0 AND expires > ? THEN password END AS password,
      expires, closed, warning,
      (SELECT count(*) FROM downloads WHERE request_id = transfers.id AND saved = 1) AS saved
    FROM transfers ORDER BY created DESC LIMIT 100
  `).all(now, now)
  return {
    files: await listFiles(), transfers,
    options: {
      sendExpires: config.fileExpireOptions, sendCount: config.fileDownloadOptions,
      receiveExpires: config.fileRequestExpireOptions, receiveCount: config.fileRequestUploadOptions,
    },
  }
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const now = Date.now()
    const due = db.prepare(`SELECT * FROM transfers WHERE kind = 'receive' AND poll_until > ? AND next_poll <= ?
      ORDER BY next_poll LIMIT 5`).all(now, now)
    for (const row of due) {
      db.prepare('UPDATE transfers SET next_poll = ? WHERE id = ?').run(Date.now() + 60_000, row.id)
      try {
        await saveArrivals(row, db)
      } catch (error) {
        const unavailable = error.status === 404 || error.status === 410
        db.prepare('UPDATE transfers SET warning = ?, poll_until = ? WHERE id = ?').run(
          unavailable ? 'Richiesta terminata sul server' : 'Inbox non disponibile. Il pannello riproverà.',
          unavailable ? 0 : row.poll_until, row.id,
        )
      }
    }
  } finally {
    polling = false
  }
}
const pollSafely = () => void poll().catch(() => console.error('Controllo periodico delle richieste non riuscito'))
setInterval(pollSafely, 10_000)
pollSafely()

const server = createServer(async (request, response) => {
  const { method, url, headers } = request
  if (!hosts.has(headers.host) || (headers.origin && !origins.has(headers.origin)) ||
      (headers['sec-fetch-site'] && !['same-origin', 'none'].includes(headers['sec-fetch-site']))) {
    return respond(response, 403, { error: 'Pannello disponibile solo su questo computer' })
  }
  if (method === 'GET') {
    const asset = staticAssets.get(url)
    if (asset) return respond(response, 200, asset.body, asset.type)
    if (url === '/health') return respond(response, 200, { ok: true })
  }
  try {
    if (method === 'GET' && url === '/api/status') return respond(response, 200, await status())
    if (method === 'POST' && ['/api/send', '/api/receive', '/api/revoke'].includes(url)) {
      if (!origins.has(headers.origin) || headers['content-type'] !== 'application/json') {
        return respond(response, 403, { error: 'Richiesta non autorizzata' })
      }
      const input = await readJson(request)
      if (url === '/api/revoke') {
        const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(input.id)
        if (!row || row.closed) return respond(response, 404, { error: 'Link già chiuso o sconosciuto' })
        try { await revoke(row) } catch (error) {
          if (error.status !== 404 && error.status !== 410) throw error
        }
        db.prepare('UPDATE transfers SET closed = 1 WHERE id = ?').run(row.id)
        return respond(response, 200, { ok: true })
      }

      const item = url === '/api/send' ? await send(input.files, input) : await requestFiles(input.label, input)
      try {
        remember(item)
      } catch (error) {
        await revoke(item).catch(() => {})
        throw error
      }
      return respond(response, 201, { id: item.id })
    }
    return respond(response, 404, { error: 'Pagina non trovata' })
  } catch (error) {
    return respond(response, 400, { error: String(error.message ?? 'Operazione non riuscita').slice(0, 300) })
  }
})
server.listen(8787, '0.0.0.0')
