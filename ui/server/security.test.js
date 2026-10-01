import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudConfig, createSecurity, isLocalApiRequest, identityContext, assertCloudOperation } from './security.js'
const env = { OPENROD_MODE: 'cloud', OPENROD_ORG_ID: 'acme', OPENROD_PUBLIC_ORIGIN: 'https://acme.openrod.example', GOOGLE_CLOUD_PROJECT: 'openrod-test', OPENROD_FIREBASE_API_KEY: 'public-key', OPENROD_FIREBASE_AUTH_DOMAIN: 'openrod-test.firebaseapp.com' }
const request = (extra = {}) => ({ method: 'GET', url: '/api/os/overview', headers: { host: 'acme.openrod.example', cookie: '__Host-openrod_session=valid', origin: env.OPENROD_PUBLIC_ORIGIN }, socket: { remoteAddress: '127.0.0.1' }, ...extra })
const account = { uid: 'user-1', email: 'user@example.com', emailVerified: true, providerData: [{providerId: 'google.com'}], customClaims: { openrod_org: 'acme', openrod_role: 'admin' } }
const auth = (user = account) => ({ verifySessionCookie: async (cookie, revoked) => { assert.equal(cookie, 'valid'); assert.equal(revoked, true); return { uid: 'user-1', exp: Math.floor(Date.now()/1000)+3600 } }, getUser: async () => user })
test('cloud configuration fails closed and local remains the default', () => {
  assert.equal(cloudConfig({}).mode, 'local')
  for (const key of Object.keys(env).filter(k => k !== 'OPENROD_MODE')) assert.throws(() => cloudConfig({ ...env, [key]: '' }))
  assert.throws(() => cloudConfig({ OPENROD_MODE: 'clod' }))
  assert.throws(() => cloudConfig({ ...env, OPENROD_PUBLIC_ORIGIN: 'http://acme.openrod.example' }))
})
test('anonymous localhost use remains protected against remote and cross-site callers', () => {
  const req = { headers: { host: '127.0.0.1:4600', origin: 'http://127.0.0.1:4600' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(isLocalApiRequest(req), true)
  assert.equal(isLocalApiRequest({ ...req, socket: { remoteAddress: '10.1.1.1' } }), false)
  assert.equal(isLocalApiRequest({ ...req, headers: { ...req.headers, origin: 'https://evil.example' } }), false)
})
test('cloud requires a verified session and a current verified Google account', async () => {
  const security = createSecurity(cloudConfig(env), auth())
  const req = request()
  assert.equal(security.isAllowed(req), false)
  const identity = await security.authenticate(req)
  assert.equal(identity.uid, 'user-1')
  assert.equal(security.isAllowed(req), true)
  await assert.rejects(security.authenticate(request({ headers: { host: 'acme.openrod.example' } })), { status: 401 })
  for (const user of [{ ...account, disabled: true }, { ...account, emailVerified: false }, { ...account, providerData: [] }]) {
    await assert.rejects(createSecurity(cloudConfig(env), auth(user)).authenticate(request()), { status: 403 })
  }
  await assert.rejects(createSecurity(cloudConfig(env), { verifySessionCookie: async () => { throw Error('revoked') } }).authenticate(request()), { status: 401 })
})
test('cloud rejects forged hosts, origins and cross-site requests including WebSockets', async () => {
  const security = createSecurity(cloudConfig(env), auth())
  for (const headers of [ { host: 'evil.example' }, { host: 'acme.openrod.example', origin: 'https://evil.example' }, { host: 'acme.openrod.example', 'sec-fetch-site': 'cross-site' } ]) {
    await assert.rejects(security.authenticate(request({ headers: { cookie: '__Host-openrod_session=valid', ...headers } })), { status: 403 })
  }
  await assert.rejects(security.authenticate(request({ method: 'POST', headers: { host: 'acme.openrod.example', cookie: '__Host-openrod_session=valid' } })), { status: 403 })
})
test('customer requests cannot read host folders or launch host applications', () => {
  identityContext.run({ uid: 'u', org: 'acme' }, () => {
    for (const parts of [['local-folder'], ['sandboxes', 'box', 'editor'], ['sandboxes', 'box', 'terminal']]) assert.throws(() => assertCloudOperation(parts, {}), { status: 403 })
    assert.throws(() => assertCloudOperation(['sandboxes'], { folder: '/etc' }), { status: 403 })
    assert.doesNotThrow(() => assertCloudOperation(['sandboxes'], { repository: 'https://github.com/example/repo' }))
  })
  assert.doesNotThrow(() => assertCloudOperation(['local-folder'], {}))
})

test('logout clears and revokes only this console session without account write privileges', async () => {
  let revoked = false
  const revocations = { has: () => revoked, add: () => { revoked = true } }
  const security = createSecurity(cloudConfig(env), auth(), revocations)
  const req = request({ method: 'POST', url: '/api/auth/logout', headers: { ...request().headers, 'x-openshell-console': '1' } })
  const headers = {}
  const res = { setHeader: (key, value) => { headers[key] = value }, writeHead: () => {}, end: () => {} }
  await security.middleware(req, res, () => assert.fail('logout must not fall through'))
  assert.equal(revoked, true)
  assert.match(headers['Set-Cookie'], /Max-Age=0/)
  await assert.rejects(security.authenticate(request()), { status: 401 })
})

test('malformed request targets return 400 instead of an unhandled rejection', async () => {
  const security = createSecurity(cloudConfig(env), auth())
  for (const url of ['//[/api/os/overview', 'https://evil.example/api/os/overview']) {
    let status
    const res = { writeHead: value => { status = value }, end: () => {} }
    await assert.doesNotReject(security.middleware(request({ url }), res, () => assert.fail('must reject malformed URL')))
    assert.equal(status, 400)
  }
})

test('Google signup immediately grants a session without claims or approval', async () => {
 const { Readable } = await import('node:stream')
 const user={uid:'new-user',email:'new@example.com',emailVerified:true,providerData:[{providerId:'google.com'}],customClaims:{}}
 let cookies=0
 const google={verifyIdToken:async()=>({uid:user.uid,exp:Math.floor(Date.now()/1000)+3600,auth_time:Math.floor(Date.now()/1000),email_verified:true,firebase:{sign_in_provider:'google.com'}}),getUser:async()=>user,createSessionCookie:async()=>{cookies++;return 'cookie'}}
 const req=Readable.from([JSON.stringify({idToken:'valid',uid:'victim',openrod_role:'admin'})]);Object.assign(req,request({method:'POST',url:'/api/auth/session',headers:{host:'acme.openrod.example',origin:env.OPENROD_PUBLIC_ORIGIN,'content-type':'application/json','x-openshell-console':'1'}}))
 let status,value,cookie
 await createSecurity(cloudConfig(env),google).middleware(req,{setHeader:(k,v)=>{if(k==='Set-Cookie')cookie=v},writeHead:s=>{status=s},end:v=>{value=JSON.parse(v)}},()=>assert.fail('signin must terminate'))
 assert.equal(status,200);assert.equal(value.user.uid,user.uid);assert.equal(value.user.role,'member');assert.match(cookie,/Max-Age=3600/);assert.equal(cookies,1)
})
