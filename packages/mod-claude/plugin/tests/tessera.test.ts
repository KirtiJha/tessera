import { describe, expect, mock, test } from 'claude-code/testing'

// A fake Tessera server and machine beneath the mod: the enrolment file, the
// session's id, and the server's answers. Nothing leaves the test.
const CONFIG = JSON.stringify({ serverUrl: 'https://tessera.test/', token: 'tok-secret', permissionWaitSeconds: 55 })
type Req = { method: string; url: string; body?: unknown; auth?: string }

function machine(on: any, opts: { config?: string | null; messages?: unknown[]; presence?: string; clock?: ReturnType<typeof mock.clock>; refuseFirst?: boolean } = {}) {
  const requests: Req[] = []
  const writes: Record<string, string> = {}
  const submitted: string[] = []
  let queue = [...(opts.messages ?? [])]
  let presence = opts.presence ?? 'auto'
  let refused = false
  mock.env(on, { HOME: '/home/ann' })
  const clock = opts.clock ?? mock.clock(on, { now: 1_000_000 })
  const logs: string[] = []
  on('ui.log', async ($: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.invalidate', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async ($: unknown, e: unknown) => e)
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 1200, window: 200000 }, rateLimits: [], cost: { usd: 0.42 } } }))
  on('fs.read', async ($: unknown, e: { path: string }) => {
    if (e.path === '/home/ann/.tessera/config.json' && opts.config !== null) return { value: opts.config ?? CONFIG }
    return { deny: 'no such file' }
  })
  on('fs.write', async ($: unknown, e: { path: string; text: string }) => {
    writes[e.path] = e.text
    return { value: undefined }
  })
  on('http.fetch', async ($: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    const method = e.init?.method ?? 'GET'
    requests.push({ method, url: e.url, body: e.init?.body ? JSON.parse(e.init.body) : undefined, auth: e.init?.headers?.authorization })
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.endsWith('/api/ingest/whoami')) return json({ device: 'ann-mbp', user: 'Ann', liveSessions: 1, presence })
    if (e.url.includes('/deliveries?')) {
      const d = queue
      queue = []
      return json({ deliveries: d, serverTime: new Date(0).toISOString() })
    }
    if (e.url.endsWith('/api/ingest/presence')) {
      presence = (JSON.parse(e.init!.body!) as { presence: string }).presence
      return json({ presence })
    }
    if (e.url.includes('/result')) return json({ ok: true })
    return { value: { status: 404, ok: false, headers: {}, text: '{}' } }
  })
  on('prompt.submit', async ($: unknown, e: { text: string }) => {
    if (opts.refuseFirst && !refused) {
      refused = true
      return { drop: 'the session was stopped and nobody has sent input since' }
    }
    submitted.push(e.text)
    return e
  })
  return { requests, writes, submitted, logs, clock }
}

describe('tessera mod', () => {
  test('/tessera shows the server, who this is, away mode and the session link', async ($, on) => {
    machine(on)
    await $.session.start({ cwd: '/repo' })
    const r = await $.command.run({ command: 'tessera', args: '' })
    expect(r.text).toContain('Reporting to https://tessera.test as Ann (device "ann-mbp").')
    expect(r.text).toContain('prompts wait 55 seconds for Tessera')
    expect(r.text).toContain('https://tessera.test/app/sessions/sess-1')
  })

  test('without an enrolment it says how to set up, and makes no requests', async ($, on) => {
    const m = machine(on, { config: null })
    await $.session.start({ cwd: '/repo' })
    const r = await $.command.run({ command: 'tessera', args: '' })
    expect(r.text).toContain('not set up on this machine')
    expect(m.requests.length).toBe(0)
  })

  test('/tessera away sets away mode on the server with the device token', async ($, on) => {
    const m = machine(on)
    await $.session.start({ cwd: '/repo' })
    const r = await $.command.run({ command: 'tessera', args: 'away' })
    expect(r.text).toContain('Away mode is on')
    const put = m.requests.find((x) => x.method === 'PUT')
    expect(put?.url).toBe('https://tessera.test/api/ingest/presence')
    expect(put?.body).toEqual({ presence: 'away' })
    expect(put?.auth).toBe('Bearer tok-secret')
    const back = await $.command.run({ command: 'tessera', args: 'back' })
    expect(back.text).toContain('Away mode is off')
  })

  test('writes Claude Code\'s own context and cost for the reporter at start', async ($, on) => {
    const m = machine(on)
    await $.session.start({ cwd: '/repo' })
    const live = JSON.parse(m.writes['/home/ann/.tessera/live/sess-1.json']!)
    expect(live).toMatchObject({ v: 1, sessionId: 'sess-1', context: { tokens: 1200, window: 200000 }, costUsd: 0.42 })
  })

  test('a message from Tessera becomes a prompt and is reported delivered', async ($, on) => {
    const m = machine(on, { messages: [{ id: 'd-1', kind: 'message', askId: null, payload: { text: 'push what you have', by: 'Raj' } }] })
    await $.session.start({ cwd: '/repo' })
    await m.clock.advance(5_000)
    await m.clock.settle()
    expect(m.submitted).toEqual(['Message from Raj via Tessera: push what you have'])
    const poll = m.requests.find((x) => x.url.includes('/deliveries?'))
    expect(poll?.url).toContain('kinds=message')
    const result = m.requests.find((x) => x.url.endsWith('/deliveries/d-1/result'))
    expect(result?.body).toEqual({ result: { applied: true, via: 'mod' } })
  })

  test('a message refused after Esc is sent again when the next turn completes', async ($, on) => {
    const m = machine(on, { refuseFirst: true, messages: [{ id: 'd-2', kind: 'message', askId: null, payload: { text: 'rebase first', by: 'Raj' } }] })
    on('turn.complete', async ($: unknown, e: unknown) => ({ text: '' }))
    await $.session.start({ cwd: '/repo' })
    await m.clock.advance(5_000)
    await m.clock.settle()
    expect(m.submitted).toEqual([])
    expect(m.requests.some((x) => x.url.endsWith('/deliveries/d-2/result'))).toBe(false)
    await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await m.clock.settle()
    expect(m.submitted).toEqual(['Message from Raj via Tessera: rebase first'])
    expect(m.requests.find((x) => x.url.endsWith('/deliveries/d-2/result'))?.body).toEqual({ result: { applied: true, via: 'mod' } })
  })

  test('the band above the prompt shows away mode, and I\'m back turns it off', async ($, on) => {
    const m = machine(on, { presence: 'away' })
    on('ui.render', async ($: any, e: any) => $.ui.resolve(e).Text({ children: ['(the prompt)'] }))
    await $.session.start({ cwd: '/repo' })
    await $.command.run({ command: 'tessera', args: '' })
    const ui = await $.ui.mount({ plugin: 'tessera', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never })
    expect((await ui.findAll({ type: 'Text', text: 'Tessera · away mode' })).length).toBe(1)
    await $.ui.press({ plugin: 'tessera', key: 'tessera-back' })
    expect(m.requests.find((x) => x.method === 'PUT')?.body).toEqual({ presence: 'auto' })
    const after = await $.ui.mount({ plugin: 'tessera', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never })
    expect((await after.findAll({ type: 'Text', text: 'Tessera · away mode' })).length).toBe(0)
  })
})
