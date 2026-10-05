import { afterEach, describe, expect, it, vi } from 'vitest'

const sessionFetch = vi.hoisted(() => vi.fn())
// Decodes nothing by default; tests that need a real image size override it.
const createFromBuffer = vi.hoisted(() =>
  vi.fn((_buffer: Buffer) => ({ isEmpty: () => true }) as unknown),
)

vi.mock('electron', () => ({
  session: { defaultSession: { fetch: sessionFetch } },
  nativeImage: { createFromBuffer },
}))

import { resolveFeedAvatar } from './feed-avatar'

describe('resolveFeedAvatar', () => {
  afterEach(() => {
    sessionFetch.mockReset()
    createFromBuffer.mockClear()
  })

  const siteWithAvatar = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
    sessionFetch.mockImplementation(async (url: string) =>
      url.endsWith('/avatar')
        ? new Response(bytes, {
            status: 200,
            headers: { 'content-type': type },
          })
        : new Response(
            '<html><head><link rel="apple-touch-icon" href="/avatar"></head></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html' },
            },
          ),
    )
  const resolveSiteAvatar = () =>
    resolveFeedAvatar(
      'https://feeds.example.com/rss',
      undefined,
      undefined,
      'https://93.184.216.34/',
    )

  it('stores a large site avatar as a small thumbnail', async () => {
    const resize = vi.fn(() => ({
      toDataURL: () => 'data:image/png;base64,thumb',
    }))
    createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 630 }),
      resize,
    })
    siteWithAvatar(new Uint8Array(300_000).fill(7), 'image/png')

    await expect(resolveSiteAvatar()).resolves.toBe(
      'data:image/png;base64,thumb',
    )
    expect(resize).toHaveBeenCalledWith({ width: 128 })
  })

  it('links a large avatar it cannot shrink instead of inlining it', async () => {
    siteWithAvatar(new Uint8Array(300_000).fill(7), 'image/webp')

    await expect(resolveSiteAvatar()).resolves.toBe(
      'https://93.184.216.34/avatar',
    )
  })

  it('uses a site-level profile image when a FeedBurner feed has no image metadata', async () => {
    const imageBytes = new Uint8Array(80).fill(1)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/blog/images/person2_s.jpg')) {
        return new Response(imageBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }

      return new Response(
        `
          <html>
            <body>
              <div class="module-categories module">
                <h2>关于</h2>
                <img src="/blog/images/person2_s.jpg" alt="个人照片" />
              </div>
              <article>
                <img src="https://cdn.example.com/latest-post-cover.webp" />
              </article>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      )
    })
    sessionFetch.mockImplementation(fetchMock)

    await expect(
      resolveFeedAvatar(
        'https://feeds.feedburner.com/ruanyifeng',
        undefined,
        undefined,
        'https://93.184.216.34/blog/',
      ),
    ).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from(imageBytes).toString('base64')}`,
    )
  })

  it('does not fetch a loopback site avatar page', async () => {
    const fetchMock = vi.fn()
    sessionFetch.mockImplementation(fetchMock)

    await expect(
      resolveFeedAvatar(
        'https://feeds.example.com/rss',
        undefined,
        'https://cdn.example.com/existing.jpg',
        'http://127.0.0.1/admin',
      ),
    ).resolves.toBe('https://cdn.example.com/existing.jpg')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not follow a site avatar redirect to loopback', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      })
    })
    sessionFetch.mockImplementation(fetchMock)

    await expect(
      resolveFeedAvatar(
        'https://feeds.example.com/rss',
        undefined,
        'https://cdn.example.com/existing.jpg',
        'https://93.184.216.34/blog/',
      ),
    ).resolves.toBe('https://cdn.example.com/existing.jpg')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not inline an oversized site avatar image', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/avatar.jpg')) {
        return new Response(new Uint8Array(80), {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(3 * 1024 * 1024),
          },
        })
      }

      return new Response(
        '<html><head><meta property="og:image" content="/avatar.jpg"></head></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      )
    })
    sessionFetch.mockImplementation(fetchMock)

    await expect(
      resolveFeedAvatar(
        'https://feeds.example.com/rss',
        undefined,
        undefined,
        'https://93.184.216.34/blog/',
      ),
    ).resolves.toBe('https://93.184.216.34/avatar.jpg')
  })
})
