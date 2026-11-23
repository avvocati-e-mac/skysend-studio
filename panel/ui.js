const send = document.querySelector('#send')
const receive = document.querySelector('#receive')
const files = document.querySelector('#files')
const history = document.querySelector('#transfers')
const message = document.querySelector('#message')
const date = new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' })
const secondsPerDay = 86_400
let busy = false
let lastFiles = ''
let lastTransfers = ''

function notice(text, error = false) {
  message.textContent = text
  message.classList.toggle('error', error)
}

async function json(path, payload) {
  const options = payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }
  const response = await fetch(path, options)
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Operazione non riuscita')
  return result
}

function choices(select, values, initial) {
  if (select.options.length) return
  for (const value of values) select.add(new Option(String(value), value, false, value === initial))
}

function button(label, action) {
  const item = document.createElement('button')
  item.type = 'button'
  item.textContent = label
  item.addEventListener('click', async () => {
    try { await action() } catch (error) { notice(error.message, true) }
  })
  return item
}

async function copy(text, label) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  else window.prompt(label, text)
  notice(label)
}

function selectedFiles() {
  return [...files.querySelectorAll('input:checked')].map(input => input.value)
}

function showFiles(names) {
  const key = JSON.stringify(names)
  if (key === lastFiles) return
  lastFiles = key
  const selected = new Set(selectedFiles())
  const legend = document.createElement('legend')
  legend.textContent = 'File disponibili'
  files.replaceChildren(legend)
  if (!names.length) {
    files.append('Aggiungi i documenti alla cartella, poi premi Aggiorna.')
    return
  }
  for (const name of names) {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = name
    checkbox.checked = selected.has(name)
    label.append(checkbox, name)
    files.append(label)
  }
}

function showTransfers(transfers) {
  const key = JSON.stringify(transfers.map(item => [item, item.expires <= Date.now()]))
  if (key === lastTransfers) return
  lastTransfers = key
  if (!transfers.length) {
    history.textContent = 'I link che crei compariranno qui.'
    return
  }
  history.replaceChildren()
  for (const item of transfers) {
    const article = document.createElement('article')
    const head = document.createElement('div')
    head.className = 'transfer-heading'
    const title = document.createElement('h3')
    title.textContent = item.label
    const status = document.createElement('span')
    const expired = item.expires <= Date.now()
    status.textContent = item.closed ? 'Chiuso' : expired ? 'Scaduto' : `Scade ${date.format(item.expires)}`
    head.append(title, status)
    const details = document.createElement('p')
    details.textContent = item.kind === 'send' ? 'Link di download' : `Ricevuti e salvati: ${item.saved}`
    article.append(head, details)
    if (item.warning) {
      const warning = document.createElement('p')
      warning.className = 'error'
      warning.textContent = item.warning
      article.append(warning)
    }
    if (!item.closed && !expired) {
      const actions = document.createElement('div')
      actions.className = 'actions'
      actions.append(button('Copia link', () => copy(item.link, 'Link copiato')))
      if (item.password) actions.append(button('Copia password', () => copy(item.password, 'Password copiata. Comunicala su un altro canale.')))
      actions.append(button(item.kind === 'send' ? 'Revoca link' : 'Chiudi richiesta', async () => {
        if (!window.confirm('Vuoi bloccare l’uso di questo link?')) return
        await json('/api/revoke', { id: item.id })
        await refresh()
        notice('Link chiuso')
      }))
      article.append(actions)
    }
    history.append(article)
  }
}

async function refresh() {
  try {
    const current = await json('/api/status')
    showFiles(current.files)
    choices(send.elements.count, current.options.sendCount, 1)
    choices(receive.elements.count, current.options.receiveCount, 1)
    showTransfers(current.transfers)
    send.querySelector('[type=submit]').disabled = busy || !current.files.length
    receive.querySelector('[type=submit]').disabled = busy
  } catch (error) {
    notice(error.message, true)
  }
}

async function create(event, endpoint, payload) {
  event.preventDefault()
  if (busy) return
  busy = true
  for (const form of [send, receive]) form.querySelector('[type=submit]').disabled = true
  notice('Creazione del link in corso…')
  try {
    await json(endpoint, payload)
    notice('Link pronto. Copialo dalla sezione Link creati.')
  } catch (error) {
    notice(error.message, true)
  } finally {
    busy = false
    await refresh()
  }
}

const sendDaysField = document.querySelector('#send-days-field')
function updateSendDays() {
  const shortExpiry = send.elements.expiryMode.value !== 'days'
  sendDaysField.hidden = shortExpiry
  send.elements.days.disabled = shortExpiry
}
for (const mode of send.elements.expiryMode) mode.addEventListener('change', updateSendDays)
updateSendDays()

send.addEventListener('submit', event => {
  const mode = send.elements.expiryMode.value
  const expires = mode === 'days' ? send.elements.days.valueAsNumber * secondsPerDay : Number(mode)
  return create(event, '/api/send', {
    files: selectedFiles(), expires, downloads: Number(send.elements.count.value),
  })
})
receive.addEventListener('submit', event => create(event, '/api/receive', {
  label: receive.elements.label.value.trim(), expires: receive.elements.days.valueAsNumber * secondsPerDay,
  uploads: Number(receive.elements.count.value),
}))
document.querySelector('#refresh').addEventListener('click', refresh)
void refresh()
setInterval(refresh, 15_000)
