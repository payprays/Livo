import { app, type IpcMainInvokeEvent } from 'electron'
import { randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, existsSync, writeFileSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { extname, join, resolve, sep } from 'path'
import {
  type IpcChannel,
  IpcValidationError,
  ipcFail,
  ipcOk,
  validateIpcArgs,
} from '../../../shared/ipc-contracts'
import { getIpcHandler, toIpcError } from '../../ipc/register-channel'
import { addEventSink, getEventBus } from '../system/event-bus'
import { logError, logInfo, logWarn } from '../system/logger'

const DEFAULT_LOCAL_API_PORT = 27412
const MAX_BODY_BYTES = 10 * 1024 * 1024
const SSE_PING_MS = 25_000
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
// 拒绝 Host 不是本机的请求，防 DNS rebinding 页面读到注入了 token 的 index.html。
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface LocalApiServer {
  port: number
  close: () => Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function tokenMatches(expected: string, actual: string | null | undefined) {
  if (!actual) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 余下的数据直接丢弃；响应带 Connection: close，发完即断开。
        chunks.length = 0
        reject(new HttpError(413, 'Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return
      if (size === 0) return resolveBody({})
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

const fakeEvent = {
  sender: {
    send: (channel: string, ...args: unknown[]) =>
      getEventBus().send(channel, ...args),
    isDestroyed: () => false,
  },
} as unknown as IpcMainInvokeEvent

async function handleIpc(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string,
): Promise<void> {
  const handler = getIpcHandler(channel as IpcChannel)
  if (!handler) return sendJson(res, 404, { error: 'Unknown channel' })

  const body = await readJsonBody(req)
  const rawArgs =
    body && typeof body === 'object' && 'args' in body ? body.args : []
  if (!Array.isArray(rawArgs)) {
    return sendJson(res, 400, { error: '"args" must be an array' })
  }

  try {
    const args = validateIpcArgs(channel as IpcChannel, rawArgs)
    sendJson(res, 200, ipcOk(await handler(fakeEvent, ...args)))
  } catch (error) {
    const payload = toIpcError(error)
    if (error instanceof IpcValidationError) {
      logWarn('[local-api-validation-error]', channel, payload)
    } else {
      logError('[local-api-handler-error]', channel, error)
    }
    sendJson(res, 200, ipcFail(payload))
  }
}

function handleEvents(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  const removeSink = addEventSink((channel, args) => {
    try {
      res.write(`data: ${JSON.stringify({ channel, args })}\n\n`)
    } catch (error) {
      logWarn('[local-api] dropped unserializable event', channel, error)
    }
  })
  const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS)
  res.on('close', () => {
    clearInterval(ping)
    removeSink()
  })
}

async function serveStatic(
  res: ServerResponse,
  pathname: string,
  staticDir: string | undefined,
  token: string,
): Promise<void> {
  if (!staticDir || !existsSync(staticDir)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(
      'Livo local API is running, but the web build was not found.\n' +
        'Run `pnpm build:web` first, then reload this page.\n',
    )
    return
  }

  const root = resolve(staticDir)
  let filePath = resolve(root, `.${pathname}`)
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return sendJson(res, 403, { error: 'Forbidden' })
  }
  const isFile = await stat(filePath).then(
    (s) => s.isFile(),
    () => false,
  )
  if (!isFile) filePath = join(root, 'index.html') // SPA 回退

  const ext = extname(filePath).toLowerCase()
  let content: Buffer | string = await readFile(filePath)
  if (filePath === join(root, 'index.html')) {
    content = content
      .toString('utf8')
      .replace(
        /<head[^>]*>/i,
        (head) =>
          `${head}\n    <meta name="livo-api-token" content="${token}">`,
      )
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  })
  res.end(content)
}

export function startLocalApiServer(options: {
  port: number
  token: string
  staticDir?: string
}): Promise<LocalApiServer> {
  const { token, staticDir } = options

  const server = createServer((req, res) => {
    const handle = async () => {
      if (!LOCAL_HOST.test(req.headers.host ?? '')) {
        return sendJson(res, 403, { error: 'Forbidden host' })
      }
      const origin = req.headers.origin
      if (origin && LOCAL_ORIGIN.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, X-Livo-Token',
        )
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return sendJson(res, 400, { error: 'Bad path' })
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: app.getVersion() })
      }

      if (req.method === 'POST' && pathname.startsWith('/api/ipc/')) {
        if (!tokenMatches(token, req.headers['x-livo-token'] as string)) {
          return sendJson(res, 401, { error: 'Unauthorized' })
        }
        return handleIpc(req, res, pathname.slice('/api/ipc/'.length))
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        if (!tokenMatches(token, url.searchParams.get('token'))) {
          return sendJson(res, 401, { error: 'Unauthorized' })
        }
        return handleEvents(res)
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not found' })
      }
      if (req.method === 'GET') {
        return serveStatic(res, pathname, staticDir, token)
      }
      sendJson(res, 405, { error: 'Method not allowed' })
    }

    handle().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) logError('[local-api] request failed', error)
      if (!res.headersSent) {
        if (status === 413) res.setHeader('Connection', 'close')
        sendJson(res, status, {
          error: error instanceof HttpError ? error.message : 'Internal error',
        })
      } else {
        res.end()
      }
    })
  })

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolveServer({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function resolveStaticDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web')
    : // out/main -> 仓库根目录；`electron out/main/index.js` 启动时 getAppPath() 是 out/main。
      join(__dirname, '../../dist-web')
}

/** 启动本地 API 并写出 local-api.json；端口被占用等失败只打日志，不影响桌面版。 */
export async function launchLocalApi(): Promise<LocalApiServer | null> {
  const port = Number(process.env.LIVO_LOCAL_API_PORT) || DEFAULT_LOCAL_API_PORT
  const token = randomBytes(24).toString('hex')
  let server: LocalApiServer | null = null
  try {
    server = await startLocalApiServer({
      port,
      token,
      staticDir: resolveStaticDir(),
    })
    const infoPath = join(app.getPath('userData'), 'local-api.json')
    writeFileSync(infoPath, JSON.stringify({ port: server.port, token }), {
      mode: 0o600,
    })
    chmodSync(infoPath, 0o600)
    logInfo(`[local-api] listening on http://127.0.0.1:${server.port}`)
    return server
  } catch (error) {
    logWarn('[local-api] failed to start, skipping', { port, error })
    await server?.close()
    return null
  }
}
