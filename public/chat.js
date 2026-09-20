/*
 * Shipo website chat widget.
 *
 * One <script> tag on any page. Everything lives inside a shadow root,
 * so a WordPress theme's global CSS cannot reach in and break it and
 * this file's CSS cannot leak out and break the theme. That is the whole
 * reason for the shadow DOM — it is not decoration.
 *
 * Embed:
 *   <script src="https://YOUR-APP-HOST/chat.js"
 *           data-endpoint="https://YOUR-APP-HOST/api/chat" defer></script>
 *
 * data-endpoint is required and deliberately has no default. Guessing a
 * host here would produce a widget that silently fails on every message.
 */
(function () {
  'use strict'

  var script = document.currentScript
  var ENDPOINT = script && script.getAttribute('data-endpoint')
  if (!ENDPOINT) {
    console.error('[shipo-chat] Missing data-endpoint on the script tag. Widget not loaded.')
    return
  }
  if (document.getElementById('shipo-chat-root')) return

  var GREETING =
    'Hi! I can answer questions about FBA prep, storage, receiving and forwarding into FBA. What are you working on?'
  var MAX_CHARS = 1000
  var MAX_TURNS = 24

  var history = [] // [{role, content}] — the assistant greeting is not sent to the API

  var host = document.createElement('div')
  host.id = 'shipo-chat-root'
  document.body.appendChild(host)
  var root = host.attachShadow({ mode: 'open' })

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;',
    'background:#00AAFF;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);display:flex;',
    'align-items:center;justify-content:center;transition:transform .15s ease}',
    '.launcher:hover{transform:scale(1.06)}',
    '.launcher svg{width:26px;height:26px;fill:#fff}',
    '.panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);',
    'height:520px;max-height:calc(100vh - 40px);background:#fff;border-radius:14px;overflow:hidden;display:none;',
    'flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3)}',
    '.panel.open{display:flex}',
    '.hdr{background:#0a0f1a;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px;flex:0 0 auto}',
    '.dot{width:34px;height:34px;border-radius:50%;background:#00AAFF;display:flex;align-items:center;',
    'justify-content:center;font-weight:700;font-size:15px;color:#fff;flex:0 0 auto}',
    '.hdr h3{font-size:14px;font-weight:600;line-height:1.3}',
    '.hdr p{font-size:11px;color:#8fa3bd;line-height:1.3}',
    '.x{margin-left:auto;background:none;border:none;color:#8fa3bd;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}',
    '.x:hover{color:#fff}',
    '.log{flex:1 1 auto;overflow-y:auto;padding:16px;background:#f6f8fa;display:flex;flex-direction:column;gap:10px}',
    '.msg{max-width:84%;padding:10px 13px;border-radius:14px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}',
    '.bot{background:#fff;color:#1a2332;border:1px solid #e3e8ef;align-self:flex-start;border-bottom-left-radius:4px}',
    '.me{background:#00AAFF;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.err{background:#fff4f4;color:#9b1c1c;border:1px solid #f5c2c2;align-self:flex-start;border-bottom-left-radius:4px}',
    '.typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#fff;border:1px solid #e3e8ef;border-radius:14px;border-bottom-left-radius:4px}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:#9aa8bd;animation:b 1.2s infinite}',
    '.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}',
    '@keyframes b{0%,60%,100%{opacity:.3}30%{opacity:1}}',
    '.bar{flex:0 0 auto;border-top:1px solid #e3e8ef;background:#fff;padding:10px;display:flex;gap:8px;align-items:flex-end}',
    'textarea{flex:1;border:1px solid #d7dee8;border-radius:9px;padding:9px 11px;font-size:13.5px;resize:none;',
    'outline:none;max-height:96px;line-height:1.45;color:#1a2332;background:#fff}',
    'textarea:focus{border-color:#00AAFF}',
    '.send{background:#00AAFF;border:none;border-radius:9px;color:#fff;padding:0 15px;height:36px;font-size:13px;',
    'font-weight:600;cursor:pointer;flex:0 0 auto}',
    '.send:disabled{background:#c3cdd9;cursor:default}',
    '.foot{font-size:10.5px;color:#93a1b3;text-align:center;padding:0 10px 9px;background:#fff}',
    '@media (max-width:480px){.panel{right:8px;bottom:8px;width:calc(100vw - 16px);height:calc(100vh - 16px)}}',
    '</style>',
    '<button class="launcher" aria-label="Open chat">',
    '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>',
    '</button>',
    '<div class="panel" role="dialog" aria-label="Shipo assistant">',
    '<div class="hdr"><div class="dot">S</div><div><h3>Shipo Assistant</h3><p>Answers instantly, 24/7</p></div>',
    '<button class="x" aria-label="Close chat">&times;</button></div>',
    '<div class="log"></div>',
    '<div class="bar"><textarea rows="1" placeholder="Ask about FBA prep, storage, receiving…" maxlength="' +
      MAX_CHARS +
      '"></textarea>',
    '<button class="send">Send</button></div>',
    '<div class="foot">Shipo LLC · Wilmington, DE · 302-442-2343</div>',
    '</div>',
  ].join('')

  var launcher = root.querySelector('.launcher')
  var panel = root.querySelector('.panel')
  var closeBtn = root.querySelector('.x')
  var log = root.querySelector('.log')
  var input = root.querySelector('textarea')
  var send = root.querySelector('.send')
  var busy = false
  var started = false

  function bubble(text, cls) {
    var d = document.createElement('div')
    d.className = 'msg ' + cls
    d.textContent = text // textContent, never innerHTML — model output is not markup
    log.appendChild(d)
    log.scrollTop = log.scrollHeight
    return d
  }

  function open() {
    panel.classList.add('open')
    launcher.style.display = 'none'
    if (!started) {
      started = true
      bubble(GREETING, 'bot')
    }
    input.focus()
  }

  function close() {
    panel.classList.remove('open')
    launcher.style.display = 'flex'
  }

  launcher.addEventListener('click', open)
  closeBtn.addEventListener('click', close)

  input.addEventListener('input', function () {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 96) + 'px'
  })

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })

  send.addEventListener('click', submit)

  function submit() {
    if (busy) return
    var text = input.value.trim()
    if (!text) return

    if (history.length >= MAX_TURNS) {
      bubble(
        "We've covered a lot here. Email Support@shipousa.com or call 302-442-2343 and a person will pick it up.",
        'err'
      )
      return
    }

    bubble(text, 'me')
    history.push({ role: 'user', content: text.slice(0, MAX_CHARS) })
    input.value = ''
    input.style.height = 'auto'
    busy = true
    send.disabled = true

    var dots = document.createElement('div')
    dots.className = 'typing'
    dots.innerHTML = '<i></i><i></i><i></i>'
    log.appendChild(dots)
    log.scrollTop = log.scrollHeight

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, page: location.href }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, body: j }
        })
      })
      .then(function (res) {
        dots.remove()
        if (!res.ok || !res.body || !res.body.reply) {
          var m =
            (res.body && res.body.error) ||
            "Something went wrong. Email Support@shipousa.com and we'll answer today."
          bubble(m, 'err')
          // Drop the turn that failed so a retry doesn't send a broken history.
          history.pop()
          return
        }
        history.push({ role: 'assistant', content: res.body.reply })
        bubble(res.body.reply, 'bot')
      })
      .catch(function () {
        dots.remove()
        history.pop()
        bubble(
          "I couldn't reach the server. Email Support@shipousa.com or call 302-442-2343.",
          'err'
        )
      })
      .then(function () {
        busy = false
        send.disabled = false
        input.focus()
      })
  }
})()
