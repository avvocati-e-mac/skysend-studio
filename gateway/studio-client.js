(() => {
  // Le pagine cliente usano il router di SkySend. Una navigazione interna
  // fuori da questi percorsi torna al server, dove si applica il filtro HTTP.
  const customerPath = /^\/(?:file|d|request)\/[0-9a-f-]{36}\/?$/
  const permitted = url => url.origin === location.origin && customerPath.test(url.pathname)

  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link) return
    const target = new URL(link.href)
    // Lascia che il browser chieda la pagina direttamente al gateway.
    if (target.origin === location.origin && !permitted(target)) event.stopImmediatePropagation()
  }, true)

  for (const method of ['pushState', 'replaceState']) {
    const navigate = history[method].bind(history)
    history[method] = (state, title, url) => {
      if (url != null) {
        const target = new URL(url, location.href)
        if (target.origin === location.origin && !permitted(target)) {
          location.assign(url)
          return
        }
      }
      navigate(state, title, url)
    }
  }

  window.addEventListener('popstate', () => {
    if (!permitted(new URL(location.href))) location.reload()
  })
})()
