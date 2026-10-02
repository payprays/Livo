import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for everything the reader talks to in e2e tests:
 * - `/feed/:name.xml` RSS feeds ("big" spans several list pages, "small" has 3)
 * - `/v1/chat/completions` an OpenAI-compatible endpoint with canned replies
 *
 * RSS fetching allows loopback (self-hosted RSSHub), so the app can subscribe
 * to these URLs without network access.
 */
export const FEEDS = {
  big: { title: 'QA Big Feed', count: 45, prefix: 'Big post' },
  small: { title: 'QA Small Feed', count: 3, prefix: 'Small post' },
} as const

export const TRANSLATION_MARK = '【译】'
export const SUMMARY_TEXT = '这是测试摘要。'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

// Fixed per process so every fetch of a feed reports the same dates.
const BASE_TIME = Date.now()

function rss(origin: string, name: keyof typeof FEEDS): string {
  const feed = FEEDS[name]
  const items = Array.from({ length: feed.count }, (_, i) => {
    const n = i + 1
    // Newest first, all within the last day so the daily digest picks them up.
    // The description must not start with the title, or entry-builder treats
    // the title as truncated and uses the description instead.
    const date = new Date(BASE_TIME - n * 60_000).toUTCString()
    return `<item>
  <title>${feed.prefix} ${n}</title>
  <link>${origin}/post/${name}/${n}</link>
  <guid>${origin}/post/${name}/${n}</guid>
  <pubDate>${date}</pubDate>
  <description><![CDATA[<p>First paragraph of item ${n} about cloud security.</p><p>Second paragraph of item ${n} with more detail.</p>]]></description>
</item>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${feed.title}</title><link>${origin}/</link><description>${feed.title}</description>
${items.join('\n')}
</channel></rss>`
}

// Pick a canned reply from the prompt that the app sent (see src/main/services/ai).
function reply(body: string): string {
  const ids = [...new Set(body.match(UUID) ?? [])]
  // Digest stage 1: candidate selection expects strict JSON ids.
  if (body.includes('候选集筛选器')) return JSON.stringify({ ids })
  // Digest stage 2: per-batch key points.
  if (body.includes('阅读分析助手')) return `- 测试要点（${ids[0] ?? ''}）`
  // Digest stage 3: final report, citing source ids like a real model.
  if (body.includes('简报编辑')) {
    return `# 今日简报\n\n## 关键趋势\n\n- 测试趋势（${ids.slice(0, 2).join('、')}）\n`
  }
  if (body.includes('professional translator')) {
    return `${TRANSLATION_MARK}测试译文`
  }
  return SUMMARY_TEXT
}

function completion(text: string, stream: boolean): string {
  const base = { id: 'qa', object: 'chat.completion', created: 0, model: 'qa' }
  if (!stream) {
    return JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
    })
  }
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      ...base,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: text }, null) +
    chunk({}, 'stop') +
    'data: [DONE]\n\n'
  )
}

export async function startFakeUpstream(): Promise<{
  origin: string
  feedUrl: (name: keyof typeof FEEDS) => string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`
    const feedMatch = req.url?.match(/^\/feed\/(big|small)\.xml/)
    if (req.method === 'GET' && feedMatch) {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
      res.end(rss(origin, feedMatch[1] as keyof typeof FEEDS))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (part) => (body += part))
      req.on('end', () => {
        const stream = (JSON.parse(body) as { stream?: boolean }).stream
        res.writeHead(200, {
          'Content-Type': stream ? 'text/event-stream' : 'application/json',
        })
        res.end(completion(reply(body), !!stream))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    feedUrl: (name) => `${origin}/feed/${name}.xml`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
