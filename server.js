const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PORT) || 8787
const HOST = '127.0.0.1'
const ENV_ID = 'cloud1-d4gxq6a5q387b50ea'
const GATEWAY = `https://${ENV_ID}.service.tcloudbase.com`
const PUBLIC_DIR = __dirname

function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('图片太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function readCookies(req) {
  const out = {}
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  })
  return out
}

function sessionFrom(req) {
  const raw = readCookies(req).admin_session
  if (!raw) return null
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (!data.uid || !data.token) return null
    return data
  } catch (error) {
    return null
  }
}

function sessionCookie(user) {
  const value = Buffer.from(JSON.stringify({ uid: user._id, token: user.sessionToken })).toString('base64url')
  return `admin_session=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax`
}

async function callFunction(name, data) {
  let response
  try {
    response = await fetch(`${GATEWAY}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    })
  } catch (error) {
    return { success: false, message: '连不上云开发：' + error.message }
  }
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch (error) {
    return { success: false, message: text.slice(0, 180) || '云端返回了无法识别的内容' }
  }
  if (body && typeof body.body === 'string' && body.statusCode) {
    try { body = JSON.parse(body.body) } catch (error) {}
  }
  if (body && (body.code === 'INVALID_PATH' || body.code === 'INVALID_ENV')) {
    return { success: false, message: '云端还没有开通网页访问路径 /' + name }
  }
  if (body && body.message && !body.success && !body.data) return body
  return body
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, 'not found')
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`)
  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req)
      const result = await callFunction('auth', {
        action: 'adminLogin',
        username: body.username,
        password: body.password
      })
      const user = result && result.data && result.data.user
      if (!result || !result.success || !user || !user.sessionToken) {
        return send(res, 401, { message: (result && result.message) || '登录失败' })
      }
      return send(res, 200, { nickName: user.nickName || '管理员' }, { 'Set-Cookie': sessionCookie(user) })
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const session = sessionFrom(req)
      if (session) {
        await callFunction('auth', { action: 'logout', _uid: session.uid, _token: session.token })
      }
      return send(res, 200, { success: true }, { 'Set-Cookie': 'admin_session=; HttpOnly; Path=/; Max-Age=0' })
    }

    if (req.method === 'POST' && url.pathname === '/api/call') {
      const session = sessionFrom(req)
      if (!session) return send(res, 401, { message: '请先登录' })
      const body = await readBody(req)
      if (!['admin', 'admin-stats'].includes(body.name)) return send(res, 400, { message: '不支持这个接口' })
      const result = await callFunction(body.name, { ...(body.data || {}), _uid: session.uid, _token: session.token })
      if (!result || result.success === false) return send(res, 400, { message: (result && result.message) || '请求失败' })
      return send(res, 200, { data: result.data })
    }

    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const filePath = path.normalize(path.join(PUBLIC_DIR, relative))
      if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden')
      return serveFile(res, filePath)
    }

    send(res, 404, { message: 'not found' })
  } catch (error) {
    send(res, 400, { message: error.message || '请求无效' })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`admin web http://${HOST}:${PORT}`)
})
