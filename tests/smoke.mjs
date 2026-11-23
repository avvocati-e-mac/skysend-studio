// Eseguire nel container panel di un progetto usa e getta, con il gateway avviato.
// Dal computer host, creare prima un file collaudo.txt in Download per i clienti
// contenente esattamente la stringa "Documento di collaudo", senza ritorno a capo.
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { setTimeout as wait } from 'node:timers/promises'
import { generateSecret, generateSalt } from '/app/packages/crypto/dist/index.js'
import {
  archiveMetadata, createApiClient, decryptedStream, decryptUploadMetadata, keysFromLink,
  newSubmission, openRequestLink, parseShareLink, plaintextOf, uploadEncrypted, withUnlockedMeta,
} from '/app/packages/transfer/dist/index.js'
import hashWasm from '/app/node_modules/.pnpm/hash-wasm@4.13.0/node_modules/hash-wasm/dist/index.umd.js'

const local = 'http://127.0.0.1:8787'
const gateway = 'http://client-gateway:3000'
const api = createApiClient({ baseUrl: gateway })
const argon2id = (password, salt, params) => hashWasm.argon2id({
  password, salt, parallelism: params.parallelism, iterations: params.iterations,
  memorySize: params.memory, hashLength: params.hashLength, outputType: 'binary',
})
const fixture = new TextEncoder().encode('Documento di collaudo')
const payload = JSON.stringify({})
const headers = { 'Content-Type': 'application/json' }
const fixtureName = 'collaudo.txt'
await assert.rejects(() => writeFile('/documents/Download per i clienti/non-scrivibile.txt', fixture), { code: 'EROFS' })
assert.deepEqual(new Uint8Array(await readFile('/documents/Download per i clienti/' + fixtureName)), fixture)

async function localAction(path, body) {
  const response = await fetch(local + path, {
    method: 'POST', headers: { ...headers, Origin: local }, body: JSON.stringify(body),
  })
  const result = await response.json()
  assert(response.ok, JSON.stringify(result))
  return result
}
async function history(id) {
  const response = await fetch(local + '/api/status')
  return (await response.json()).transfers.find(item => item.id === id)
}

// L'ingresso pubblico rifiuta sia le pagine private che l'API di creazione.
for (const [path, method] of [
  ['/', 'GET'], ['/api/status', 'GET'], ['/api/request', 'POST'],
  ['/api/upload/init', 'POST'], ['/api/upload/ws', 'GET'], ['/api/note', 'POST'],
  ['/inbox/00000000-0000-4000-8000-000000000000', 'GET'],
]) {
  const response = await fetch(gateway + path, { method, headers, body: method === 'POST' ? payload : undefined })
  assert.equal(response.status, 404, path)
  assert.equal(response.headers.get('cache-control'), 'no-store', path)
}
assert.equal((await fetch(local + '/api/receive', {
  method: 'POST', headers: { ...headers, Origin: 'https://send.example.test' }, body: payload,
})).status, 403)
const otherHost = await new Promise((resolve, reject) => {
  get(local, { headers: { Host: 'send.example.test' } }, response => {
    response.resume()
    resolve(response.statusCode)
  }).on('error', reject)
})
assert.equal(otherHost, 403)
assert.equal((await fetch(local + '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
const customerPath = '/file/00000000-0000-4000-8000-000000000000'
const plainResponse = await fetch(gateway + customerPath, {
  headers: { 'X-Forwarded-Proto': 'http' }, redirect: 'manual',
})
assert.equal(plainResponse.status, 308)
assert.equal(plainResponse.headers.get('location'), 'https://client-gateway' + customerPath)
const pageResponse = await fetch(gateway + customerPath)
assert.equal(pageResponse.status, 200)
assert.equal(pageResponse.headers.get('cache-control'), 'no-store')
assert(pageResponse.headers.get('content-security-policy').includes("'wasm-unsafe-eval'"))
const customerHtml = await pageResponse.text()
const guardPosition = customerHtml.indexOf('<script src="/studio-client.js"></script>')
assert(guardPosition >= 0 && guardPosition < customerHtml.indexOf('<script type="module"'))
assert.equal((await fetch(gateway + '/studio-client.js')).headers.get('cache-control'), 'no-store')
const statusResponse = await fetch(local + '/api/status')
assert.equal(statusResponse.headers.get('cache-control'), 'no-store')
const { options } = await statusResponse.json()
const dailyExpiries = Array.from({ length: 15 }, (_, index) => (index + 1) * 86400)
const maxExpiry = dailyExpiries.at(-1)
assert.deepEqual(options.sendExpires, [300, 3600, ...dailyExpiries])
assert.deepEqual(options.receiveExpires, dailyExpiries)
await assert.rejects(() => localAction('/api/send', { files: [fixtureName], expires: 16 * 86400, downloads: 1 }), /Scadenza/)
await assert.rejects(() => localAction('/api/receive', { label: 'Fuori limite', expires: 16 * 86400, uploads: 1 }), /Scadenza/)

const sent = await localAction('/api/send', { files: [fixtureName], expires: maxExpiry, downloads: 1 })
const sendItem = await history(sent.id)
assert.equal(new URL(sendItem.link).origin, 'https://send.example.test')
assert.equal((await fetch(gateway + new URL(sendItem.link).pathname)).status, 200)
const link = parseShareLink(sendItem.link, ['file'])
const info = await api.fetchInfo(link.id)
assert.equal(info.hasPassword, true)
assert.equal(info.maxDownloads, 1)
assert.equal(Date.parse(info.expiresAt) - Date.parse(info.createdAt), maxExpiry * 1000)
const keys = await keysFromLink(link.secret, info.salt, {
  password: sendItem.password, saltB64: info.passwordSalt, argon2id,
})
const wrongKeys = await keysFromLink(link.secret, info.salt, {
  password: 'Password-di-prova-errata', saltB64: info.passwordSalt, argon2id,
})
assert.equal(await api.verifyPassword(link.id, wrongKeys.authToken), null)
const unlocked = await api.verifyPassword(link.id, keys.authToken)
assert(unlocked)
const metadata = await decryptUploadMetadata(withUnlockedMeta(info, unlocked), keys.keys.metaKey)
const { stream } = await api.downloadFile(link.id, keys.authToken)
const cleartext = await new Response(decryptedStream(stream, metadata, keys.keys.fileKey)).arrayBuffer()
assert.deepEqual(new Uint8Array(cleartext), fixture)
await assert.rejects(() => api.downloadFile(link.id, keys.authToken))
console.log('Download pubblico protetto, contenuto integro, secondo download rifiutato')

const beforeRequest = Date.now()
const received = await localAction('/api/receive', { label: 'Pratica locale di prova', expires: maxExpiry, uploads: 1 })
const receiveItem = await history(received.id)
assert(receiveItem.expires >= beforeRequest + maxExpiry * 1000)
assert(receiveItem.expires <= Date.now() + maxExpiry * 1000)
const requestLink = parseShareLink(receiveItem.link, ['request'])
assert.equal((await fetch(gateway + new URL(receiveItem.link).pathname)).status, 200)
assert.equal((await fetch(gateway + '/api/inbox/' + received.id)).status, 404)
const request = await openRequestLink(api, requestLink.id, requestLink.secret)
assert.equal(request.state, 'ready')
assert.equal(request.brief.title, 'Invio documenti')
const uploadMetadata = { type: 'single', name: fixtureName, size: fixture.length, mimeType: 'text/plain', submission: newSubmission() }
const delivered = await uploadEncrypted({
  api, config: await api.fetchConfig(), metadata: uploadMetadata, password: '', argon2id,
  secret: generateSecret(), salt: generateSalt(), fileCount: 1, expireSec: 0, maxDownloads: 0,
  plaintext: plaintextOf([{ size: fixture.length, stream: () => new Blob([fixture]).stream() }], uploadMetadata),
  request: { id: requestLink.id, ...request.access },
})
assert.equal(delivered.kind, 'delivered')
for (let attempt = 0; attempt < 42 && (await history(received.id)).saved === 0; attempt++) await wait(2000)
const folder = '/documents/Upload dai clienti/' + received.id + ' - Pratica locale di prova'
assert.deepEqual(new Uint8Array(await readFile(folder + '/' + fixtureName)), fixture)
assert.deepEqual(await readdir(folder), [fixtureName])
assert.equal((await history(received.id)).saved, 1)
await localAction('/api/revoke', { id: received.id })
assert.equal((await history(received.id)).link, null)
const closed = await openRequestLink(api, requestLink.id, requestLink.secret)
assert.equal(closed.status.open, false)
console.log('Upload del cliente salvato automaticamente sul Mac e richiesta chiusa')

const multi = await localAction('/api/receive', { label: 'Prova archivio', expires: 86400, uploads: 1 })
const multiLink = parseShareLink((await history(multi.id)).link, ['request'])
const multiRequest = await openRequestLink(api, multiLink.id, multiLink.secret)
assert.equal(multiRequest.state, 'ready')
const archive = {
  ...archiveMetadata([{ name: 'uno.txt', size: fixture.length }, { name: 'due.txt', size: fixture.length }]),
  submission: newSubmission(),
}
const source = { size: fixture.length, stream: () => new Blob([fixture]).stream() }
let transport
await uploadEncrypted({
  api, config: await api.fetchConfig(), metadata: archive, password: '', argon2id,
  secret: generateSecret(), salt: generateSalt(), fileCount: 2, expireSec: 0, maxDownloads: 0,
  plaintext: plaintextOf([source, source], archive), request: { id: multi.id, ...multiRequest.access },
  openWebSocket: url => new WebSocket(url, { headers: { Origin: 'https://send.example.test' } }),
  onTransport: value => { transport = value },
})
assert.equal(transport, 'ws')
for (let attempt = 0; attempt < 42 && (await history(multi.id)).saved === 0; attempt++) await wait(2000)
const zip = await readFile('/documents/Upload dai clienti/' + multi.id + ' - Prova archivio/Documenti.zip')
assert(zip.includes('uno.txt') && zip.includes('due.txt'))
console.log('Due file trasmessi via WebSocket e salvati in un solo ZIP')
