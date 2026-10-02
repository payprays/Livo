import { expect, test, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FEEDS,
  SUMMARY_TEXT,
  TRANSLATION_MARK,
  startFakeUpstream,
} from '../fixtures/fake-upstream'

// Regression tests for reader bugs found during manual QA. One app instance is
// shared and seeded with local fixture feeds plus a fake OpenAI endpoint, so
// the run needs no network and never touches real user data.
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDir: string
let upstream: Awaited<ReturnType<typeof startFakeUpstream>>

const sidebarFeed = (title: string) =>
  page.getByRole('button', { name: new RegExp(`^${title}`) }).first()
const unreadBadge = async (title: string) =>
  (await sidebarFeed(title).innerText()).split('\n').pop()?.trim()
const openEntry = (title: string) =>
  page.getByText(title, { exact: true }).first().click()
const readerTitle = () => page.locator('h1').first()

test.beforeAll(async () => {
  upstream = await startFakeUpstream()
  userDataDir = await mkdtemp(join(tmpdir(), 'livo-e2e-reader-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...env,
      LIVO_E2E: '1',
      LIVO_E2E_USER_DATA: userDataDir,
      // Keep clear of a locally running Livo, which owns the default port.
      LIVO_LOCAL_API_PORT: String(30_000 + Math.floor(Math.random() * 20_000)),
    },
  })
  page = await app.firstWindow()
  await expect(page.locator('#root')).toBeVisible()

  await page.evaluate(
    async ({ baseUrl, feedUrls }) => {
      await window.api.settings.set({
        ai: { provider: 'custom', apiKey: 'qa-key', baseUrl, model: 'qa' },
      })
      for (const url of feedUrls) await window.api.feeds.add(url, 'QA')
      // Adding stores a preview; a refresh pulls every item.
      for (const feed of await window.api.feeds.list()) {
        await window.api.feeds.refresh(feed.id)
      }
    },
    {
      baseUrl: `${upstream.origin}/v1`,
      feedUrls: [upstream.feedUrl('big'), upstream.feedUrl('small')],
    },
  )
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        (await window.api.feeds.list()).map((feed) => feed.unreadCount),
      ),
    )
    .toEqual(expect.arrayContaining([FEEDS.big.count, FEEDS.small.count]))

  // Reload so the stores hydrate the seeded feeds and settings.
  await page.reload()
  await expect(sidebarFeed(FEEDS.small.title)).toBeVisible()
  // Keyboard shortcuts are registered by a lazy provider after the shell.
  await expect(page.locator('html[data-shortcuts-ready]')).toHaveCount(1)
})

test.afterAll(async () => {
  await app?.close()
  await upstream?.close()
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
})

test('sidebar unread badge follows read state changes', async () => {
  const feed = FEEDS.small.title
  await sidebarFeed(feed).click()
  await expect.poll(() => unreadBadge(feed)).toBe('3')

  await openEntry(`${FEEDS.small.prefix} 1`)
  await expect.poll(() => unreadBadge(feed)).toBe('2')

  // Reader shortcuts exist once the reader has rendered the entry.
  await expect(readerTitle()).toHaveText(`${FEEDS.small.prefix} 1`)

  await page.keyboard.press('m')
  await expect.poll(() => unreadBadge(feed)).toBe('3')

  await page.getByRole('button', { name: '全部标为已读', exact: true }).click()
  await expect.poll(() => unreadBadge(feed)).toBe('0')
})

test('J keeps going past the first loaded page', async () => {
  await sidebarFeed(FEEDS.big.title).click()
  await openEntry(`${FEEDS.big.prefix} 1`)
  await expect(readerTitle()).toHaveText(`${FEEDS.big.prefix} 1`)

  // The list loads 20 entries per page; 22 requires loading the next page.
  for (let n = 2; n <= 22; n++) {
    await page.keyboard.press('j')
    await expect(readerTitle()).toHaveText(`${FEEDS.big.prefix} ${n}`)
  }
})

test('shortcuts keep working after starting an AI summary', async () => {
  await sidebarFeed(FEEDS.big.title).click()
  await openEntry(`${FEEDS.big.prefix} 1`)
  await page.locator('button[title="AI 摘要"]').click()
  await expect(page.getByText(SUMMARY_TEXT)).toBeVisible()

  // The summary button is disabled while it runs, which drops focus to <body>.
  await page.keyboard.press('j')
  await expect(readerTitle()).toHaveText(`${FEEDS.big.prefix} 2`)
})

// Smoke test for the bilingual view. Translating readability content is not
// covered here: readability refuses loopback URLs, so the fixture page can't be
// fetched. entry-content-layout.test.ts covers that layout decision.
test('bilingual translation interleaves translated paragraphs', async () => {
  await sidebarFeed(FEEDS.big.title).click()
  await openEntry(`${FEEDS.big.prefix} 3`)
  await page.locator('button[title="中英对照翻译"]').click()

  const translations = page.locator('.entry-content.text-accent\\/80')
  await expect(translations.first()).toContainText(TRANSLATION_MARK)
  await expect(page.locator('.entry-content').first()).toContainText(
    'First paragraph of item 3',
  )
})

test('AI digest cites sources by number, not raw ids', async () => {
  await page.getByRole('button', { name: 'AI 简报', exact: true }).click()
  await page.getByRole('button', { name: '生成', exact: true }).click()

  const report = page.locator('article').first()
  await expect(report).toContainText('[1]', { timeout: 60_000 })
  expect(await report.innerText()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/,
  )
})
