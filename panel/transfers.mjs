import { randomBytes } from 'node:crypto'
import { createWriteStream, openAsBlob } from 'node:fs'
import { link, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Le librerie compilate appartengono all'immagine SkySend fissata nel Compose.
import { generateSalt, generateSecret } from '/app/packages/crypto/dist/index.js'
import {
  archiveMetadata, archiveMetadataFits, buildShareLink, createApiClient, decryptedStream,
  openInbox, openInboxLink, plaintextOf, prepareRequest, sanitizeFilename, uniqueNames,
  uploadEncrypted,
} from '/app/packages/transfer/dist/index.js'
import hashWasm from '/app/node_modules/.pnpm/hash-wasm@4.13.0/node_modules/hash-wasm/dist/index.umd.js'

export const outgoing = '/documents/Download per i clienti'
const incoming = '/documents/Upload dai clienti'
export const api = createApiClient({
  baseUrl: 'http://server:3000',
  fetch: (url, options) => {
    const target = new URL(url)
    if (target.origin !== 'http://server:3000') throw new Error('Indirizzo interno inatteso')
    return fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(120_000) })
  },
})
const publicAddress = new URL(process.env.PUBLIC_URL)
if (publicAddress.protocol !== 'https:' || !publicAddress.hostname.includes('.') ||
    publicAddress.href !== publicAddress.origin + '/') throw new Error('Configura un sottodominio pubblico HTTPS')
const publicUrl = publicAddress.origin
const password = () => randomBytes(18).toString('base64url')
const argon2id = (password, salt, params) => hashWasm.argon2id({
  password, salt, parallelism: params.parallelism, iterations: params.iterations,
  memorySize: params.memory, hashLength: params.hashLength, outputType: 'binary',
})

export async function directory(path) {
  if (!(await exists(path))) {
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  if (!(await lstat(path)).isDirectory()) throw new Error('La cartella di lavoro deve essere una directory reale')
}

export async function listFiles() {
  const contents = await readdir(outgoing, { withFileTypes: true })
  return contents.filter(item => item.isFile() && !item.name.startsWith('.'))
    .map(item => item.name).sort((a, b) => a.localeCompare(b, 'it'))
}

export async function send(names, { expires, downloads }) {
  const available = new Set(await listFiles())
  if (!Array.isArray(names) || names.length === 0 ||
      new Set(names).size !== names.length || names.some(name => !available.has(name))) {
    throw new Error('Seleziona uno o più file presenti nella cartella dei documenti da inviare')
  }
  const config = await api.fetchConfig()
  if (names.length > config.fileMaxFilesPerUpload) throw new Error('Troppi file per un solo invio')
  if (!config.fileExpireOptions.includes(expires) || !config.fileDownloadOptions.includes(downloads)) {
    throw new Error('Scadenza o numero di download fuori dai limiti')
  }
  const files = await Promise.all(names.map(async name => {
    const blob = await openAsBlob(join(outgoing, name))
    return { size: blob.size, stream: () => blob.stream() }
  }))
  const safeNames = uniqueNames(names.map(name => sanitizeFilename(name)))
  const entries = safeNames.map((name, index) => ({ name, size: files[index].size }))
  if (!archiveMetadataFits(entries)) throw new Error('I nomi dei file sono troppo lunghi per un singolo invio')
  const metadata = files.length === 1
    ? { type: 'single', name: safeNames[0], size: files[0].size, mimeType: 'application/octet-stream' }
    : archiveMetadata(entries)
  if ((metadata.archiveSize ?? metadata.size) > config.fileMaxSize) throw new Error('I file superano il limite di upload')
  const generatedPassword = password()
  const result = await uploadEncrypted({
    api, config, metadata, password: generatedPassword, argon2id,
    salt: generateSalt(), secret: generateSecret(), fileCount: files.length,
    expireSec: expires, maxDownloads: downloads, plaintext: plaintextOf(files, metadata),
  })
  return {
    id: result.id, kind: 'send', label: names.join(', '), credential: result.ownerToken,
    password: generatedPassword, link: buildShareLink(publicUrl, 'file', result.id, result.effectiveSecret),
    expires: Date.now() + expires * 1000,
  }
}

export async function requestFiles(label, { expires, uploads }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100) {
    throw new Error('Inserisci un riferimento di massimo 100 caratteri')
  }
  const config = await api.fetchConfig()
  if (!config.fileRequestExpireOptions.includes(expires) || !config.fileRequestUploadOptions.includes(uploads)) {
    throw new Error('Scadenza o numero di invii fuori dai limiti')
  }
  const generatedPassword = password()
  // Il riferimento resta nel pannello e nel Finder. Al cliente mostriamo un titolo generico.
  const prepared = await prepareRequest({ title: 'Invio documenti', password: generatedPassword, argon2id })
  const result = await api.createRequest({
    ...prepared.body, expireSec: expires, maxUploads: uploads,
    maxSize: Math.min(config.fileRequestMaxSize, config.fileMaxSize), downloads: config.fileRequestDefaultDownloads,
  })
  return {
    id: result.id, kind: 'receive', label: label.trim(), credential: prepared.inboxFragment,
    password: generatedPassword, link: buildShareLink(publicUrl, 'request', result.id, prepared.uploadFragment),
    expires: Date.parse(result.closesAt), pollUntil: Date.parse(result.closesAt) + config.fileRequestRetention * 1000,
  }
}

const inboxAccess = row => openInboxLink(row.credential, row.password, argon2id)

export async function revoke(row) {
  if (row.kind === 'send') await api.deleteUpload(row.id, row.credential)
  else await api.closeRequest(row.id, (await inboxAccess(row)).ownerToken)
}

async function exists(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function localName(name) {
  let safe = sanitizeFilename(name).replace(/[<>:"|?*]/g, '_')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe
  const extension = Array.from(extname(safe)).slice(0, 16).join('')
  return Array.from(basename(safe, extname(safe))).slice(0, 40).join('') + extension
}

export async function saveArrivals(row, db) {
  const access = await inboxAccess(row)
  const summary = await api.fetchInbox(row.id, access.inboxToken)
  if (!summary.uploads.length) return
  const downloadRecord = db.prepare('SELECT filename, saved FROM downloads WHERE id = ?')
  const pending = summary.uploads.filter(entry => !downloadRecord.get(entry.id)?.saved)
  if (!pending.length) return
  const opened = await openInbox(row.id, { ...summary, uploads: pending }, access.keys)
  const folderLabel = localName(row.label)
  const folder = join(incoming, row.id + ' - ' + folderLabel)
  await directory(folder)
  let warning = null
  for (const { upload, file } of opened.uploads) {
    if (!file || file.metadata.type === 'note') {
      warning = 'Un allegato non è stato decifrato come documento.'
      continue
    }
    const record = downloadRecord.get(upload.id)
    const original = file.metadata.type === 'single' ? localName(file.metadata.name) : 'Documenti.zip'
    const extension = extname(original)
    const stem = basename(original, extension)
    let filename = record?.filename
    if (!filename) {
      filename = original
      let index = 1
      const reserved = db.prepare('SELECT 1 FROM downloads WHERE request_id = ? AND filename = ?')
      while (reserved.get(row.id, filename) || await exists(join(folder, filename))) {
        filename = `${stem} (${++index})${extension}`
      }
      db.prepare('INSERT INTO downloads (id, request_id, filename) VALUES (?, ?, ?)').run(upload.id, row.id, filename)
    }
    const destination = join(folder, filename)
    const partial = join(folder, `.skysend-${upload.id}.part`)
    let linked = false
    try {
      const existing = await exists(destination)
      const staged = await exists(partial)
      if (existing && (!staged?.isFile() || staged.dev !== existing.dev || staged.ino !== existing.ino)) {
        throw new Error('Il percorso è già occupato')
      }
      if (!existing) {
        await rm(partial, { force: true })
        const { stream } = await api.downloadInboxFile(row.id, upload.id, access.inboxToken)
        const decrypted = decryptedStream(stream, file.metadata, file.keys.fileKey)
        await pipeline(Readable.fromWeb(decrypted), createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
        // Rende visibile soltanto un file completo, senza sovrascrivere un documento.
        await link(partial, destination)
      }
      linked = true
      db.prepare('UPDATE downloads SET saved = 1 WHERE id = ?').run(upload.id)
      await rm(partial, { force: true })
    } catch {
      if (!linked) await rm(partial, { force: true }).catch(() => {})
      // Un allegato guasto non deve impedire il salvataggio degli altri.
      warning = 'Un allegato non è stato salvato. Controlla gli arrivi e lo spazio libero.'
    }
  }
  db.prepare('UPDATE transfers SET warning = ? WHERE id = ?').run(warning, row.id)
}
