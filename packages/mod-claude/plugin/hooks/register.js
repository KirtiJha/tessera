// The Tessera mod. It runs inside Claude Code beside the Tessera reporter's
// settings hooks, which still report every event and handle prompts. The mod
// adds what a hook cannot do:
//
// - A message sent from the Tessera console reaches this session even while
//   it sits idle at the prompt. Hooks only fire when Claude Code does
//   something, so before, a message waited for the end of the next turn.
// - /tessera shows the connection and sets away mode from the terminal, and a
//   band above the prompt says when away mode is on.
// - Claude Code's own context and cost figures go to the reporter through a
//   small file in ~/.tessera/live, in place of what the transcript implies.
//
// It reads the reporter's enrolment from ~/.tessera/config.json and never
// writes the token anywhere or logs it.

const VERSION = '0.1.0'
/** How often the background loop looks at what is due. */
const TICK_MS = 5_000
/** The long poll for messages: the server holds the request this long when nothing is queued. */
const POLL_WAIT_S = 20
/** How often the live file is refreshed, so the reporter knows the mod is still running. */
const LIVE_EVERY_MS = 30_000
/** How often away mode is read back from the server, for the band. */
const WHOAMI_EVERY_MS = 60_000
/** What Claude Code's result or error says when a prompt was refused after the user pressed Esc. */
const REFUSED = ['the session was stopped and nobody has sent input since', 'was removed from the queue before it ran']

let cfg = null
let home = null
let sessionId = null
let user = null
let device = null
let presence = 'auto'
let lastLiveAt = 0
let lastWhoamiAt = 0
let polling = false
let pollFailures = 0
let pollPausedUntil = 0
let ended = false
/** Messages Claude Code refused to start a turn for, after an interruption; sent again when a turn completes. */
let retry = []
/** The latest figures from session.measure, written to the live file. */
let measured = null

/** The reporter's home: TESSERA_HOME, or .tessera in the user's home directory. */
async function tesseraHome($) {
  const set = await $.env.get('TESSERA_HOME')
  if (set) return set
  const h = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return h ? h + '/.tessera' : null
}

/** The enrolment the reporter saved, or null when this machine is not enrolled. */
async function loadConfig($) {
  home = await tesseraHome($)
  if (!home) return null
  try {
    const raw = JSON.parse(await $.fs.read(home + '/config.json'))
    if (typeof raw.serverUrl !== 'string' || typeof raw.token !== 'string' || !raw.serverUrl || !raw.token) return null
    return {
      serverUrl: raw.serverUrl.replace(/\/+$/, ''),
      token: raw.token,
      permissionWaitSeconds: typeof raw.permissionWaitSeconds === 'number' ? raw.permissionWaitSeconds : 55,
    }
  } catch {
    return null
  }
}

/** One request to the Tessera server with the device token. Resolves to the parsed body, or null with the reason logged. */
async function api($, method, path, body) {
  if (!cfg) return null
  try {
    const r = await $.http.fetch(cfg.serverUrl + path, {
      method,
      headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!r.ok) {
      $.ui.log('Tessera ' + method + ' ' + path.split('?')[0] + ' answered ' + r.status, { to: 'debug' })
      return null
    }
    return r.text ? JSON.parse(r.text) : {}
  } catch (err) {
    // Network, proxy or a body that is not JSON. The message carries no token: the token only travels in a header.
    $.ui.log('Tessera ' + method + ' ' + path.split('?')[0] + ' failed: ' + String(err && err.message ? err.message : err).slice(0, 200), { to: 'debug' })
    return null
  }
}

/** Write Claude Code's figures for the reporter. The reporter ignores a file older than 90 s. */
async function writeLive($, figures, now) {
  if (!home || !sessionId) return
  const f = figures || (await $.session.usage())
  const context = f && f.context && f.context.window ? { tokens: typeof f.context.tokens === 'number' ? f.context.tokens : null, window: f.context.window } : null
  const file = { v: 1, at: now, sessionId, modVersion: VERSION, context, costUsd: f && f.cost && typeof f.cost.usd === 'number' ? f.cost.usd : null }
  try {
    await $.fs.write(home + '/live/' + sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json', JSON.stringify(file))
    lastLiveAt = now
  } catch (err) {
    $.ui.log('Tessera could not write its live file: ' + String(err && err.message ? err.message : err).slice(0, 200), { to: 'debug' })
  }
}

/** Read back who this device is and whether away mode is on. */
async function refreshWhoami($, now) {
  lastWhoamiAt = now
  const who = await api($, 'GET', '/api/ingest/whoami')
  if (!who) return false
  user = typeof who.user === 'string' ? who.user : user
  device = typeof who.device === 'string' ? who.device : device
  const was = presence
  if (who.presence === 'auto' || who.presence === 'desk' || who.presence === 'away') presence = who.presence
  if (was !== presence) $.ui.invalidate('ui.render')
  return true
}

/** Submit one message from Tessera as a turn of its own. Claude Code holds it until the session is idle. */
async function submitMessage($, d) {
  const by = d.payload && typeof d.payload.by === 'string' ? d.payload.by : 'a reviewer'
  const text = d.payload && typeof d.payload.text === 'string' ? d.payload.text : ''
  if (!text) {
    await api($, 'POST', '/api/ingest/deliveries/' + d.id + '/result', { result: { applied: false, reason: 'empty message' } })
    return
  }
  let reason = ''
  try {
    const r = await $.prompt.submit({ text: 'Message from ' + by + ' via Tessera: ' + text })
    reason = r && typeof r.drop === 'string' ? r.drop : ''
  } catch (err) {
    reason = String(err && err.message ? err.message : err)
  }
  if (REFUSED.some((x) => reason.includes(x))) {
    // The user pressed Esc. Claude Code starts nothing until they type again, so send it after their next turn.
    if (!retry.some((x) => x.id === d.id)) retry.push(d)
    return
  }
  await api($, 'POST', '/api/ingest/deliveries/' + d.id + '/result', { result: reason ? { applied: false, reason: reason.slice(0, 300) } : { applied: true, via: 'mod' } })
  if (!reason) $.ui.toast('Message from ' + by + ' delivered from Tessera')
}

/** One long poll for messages. Only messages: answers stay queued for the hook that is waiting on them. */
async function pollMessages($, now) {
  if (polling || now < pollPausedUntil) return
  polling = true
  try {
    const r = await api($, 'GET', '/api/ingest/sessions/' + encodeURIComponent(sessionId) + '/deliveries?wait=' + POLL_WAIT_S + '&kinds=message')
    if (!r) {
      // Back off on failure, up to a minute, so an unreachable server is not hammered.
      pollFailures += 1
      pollPausedUntil = now + Math.min(60_000, TICK_MS * 2 ** Math.min(pollFailures, 4))
      return
    }
    pollFailures = 0
    for (const d of Array.isArray(r.deliveries) ? r.deliveries : []) if (d && d.kind === 'message') void submitMessage($, d)
  } finally {
    polling = false
  }
}

/** The background loop: what is due, every few seconds, between and during turns. */
async function tick($) {
  if (!cfg || ended || !sessionId) return
  const now = await $.clock.now()
  if (now - lastLiveAt >= LIVE_EVERY_MS) await writeLive($, measured, now)
  if (now - lastWhoamiAt >= WHOAMI_EVERY_MS) await refreshWhoami($, now)
  void pollMessages($, now)
}

/** What a prompt waits for under each presence, as the reporter's hooks apply it. */
function waitLine(p) {
  if (p === 'away') return 'Away mode is on: prompts wait up to 10 minutes for an answer from Tessera, then the terminal asks.'
  if (p === 'desk') return 'At your desk: prompts wait about 15 seconds for Tessera, then the terminal asks.'
  return 'Away mode is off: prompts wait ' + (cfg ? cfg.permissionWaitSeconds : 55) + ' seconds for Tessera, then the terminal asks.'
}

/** Set away mode for this person, as the console's switch does. */
async function setPresence($, p) {
  const r = await api($, 'PUT', '/api/ingest/presence', { presence: p })
  if (!r) return false
  presence = r.presence === 'away' || r.presence === 'desk' ? r.presence : 'auto'
  $.ui.invalidate('ui.render')
  return true
}

async function statusText($) {
  if (!cfg) return 'Tessera is not set up on this machine. Run the installer line from the Devices page of your Tessera console.'
  const ok = await refreshWhoami($, await $.clock.now())
  const lines = [
    ok ? 'Reporting to ' + cfg.serverUrl + ' as ' + (user || 'you') + (device ? ' (device "' + device + '")' : '') + '.' : 'Cannot reach ' + cfg.serverUrl + ' just now. The session keeps working; Tessera catches up when the server answers.',
    waitLine(presence),
    'Messages sent from Tessera reach this session even while it is idle.',
  ]
  if (sessionId) lines.push('This session in Tessera: ' + cfg.serverUrl + '/app/sessions/' + encodeURIComponent(sessionId))
  lines.push('Commands: /tessera away · /tessera back · /tessera desk')
  return lines.join('\n')
}

async function start($, id) {
  sessionId = id
  ended = false
  cfg = await loadConfig($)
  if (!cfg) return
  const now = await $.clock.now()
  await writeLive($, null, now)
  void refreshWhoami($, now)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await start($, await $.session.id())
      $.clock.every(TICK_MS, async () => {
        await tick($)
      })
    } catch (err) {
      $.ui.log('Tessera mod did not start: ' + String(err && err.message ? err.message : err).slice(0, 200), { to: 'debug' })
    }
    // Last: a name already taken throws, and that must not stop the rest.
    try {
      await $.command.register({ name: 'tessera', description: 'Tessera: connection, away mode, and a link to this session', argumentHint: '[away|back|desk]', immediate: true })
    } catch (err) {
      $.ui.log('Tessera could not add /tessera: ' + String(err && err.message ? err.message : err).slice(0, 200), { to: 'debug' })
    }
    return next(e)
  })

  // /clear and /resume carry on under another session id.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.session_id && e.session_id !== sessionId) await start($, e.session_id)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    measured = { context: e.context, cost: e.cost }
    await writeLive($, measured, await $.clock.now())
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A message refused after an interruption goes now that the user has typed again.
    if (!e.agentId && retry.length) {
      const again = retry
      retry = []
      for (const d of again) void submitMessage($, d)
    }
    return next(e)
  })

  // The reporter's SessionEnd hook deletes the live file, and one that stops being refreshed is ignored after 90 s.
  on('session.end', async ($, e, next) => {
    ended = true
    return next(e)
  })

  on('command.run', { command: 'tessera' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    if (!cfg) return { text: await statusText($) }
    if (arg === 'away' || arg === 'back' || arg === 'auto' || arg === 'desk') {
      const want = arg === 'back' ? 'auto' : arg
      const ok = await setPresence($, want)
      return { text: ok ? waitLine(presence) : 'Could not reach ' + cfg.serverUrl + ' to change away mode. Try again, or use the switch in the console.' }
    }
    if (arg && arg !== 'status') return { text: 'Unknown option "' + arg.slice(0, 40) + '". Use /tessera, /tessera away, /tessera back or /tessera desk.' }
    return { text: await statusText($) }
  })

  // The band above the prompt says when away mode is on, with a way back.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg || presence !== 'away') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    const band = Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ color: 'yellow', children: ['Tessera · away mode'] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: ['Prompts wait up to 10 min for an answer from your phone or the console.'] }),
        Button({ key: 'tessera-back', label: "I'm back", onPress: async () => { await setPresence($, 'auto') } }),
      ],
    })
    return theirs ? Box({ flexDirection: 'column', children: [band, theirs] }) : band
  })
}
