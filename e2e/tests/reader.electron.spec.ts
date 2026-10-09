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

test('auto translate setting translates an article on open', async () => {
  await page.evaluate(() =>
    window.api.settings.set({
      translation: { enabled: true, autoTranslate: true },
    } as never),
  )
  await page.reload()
  await expect(page.locator('html[data-shortcuts-ready]')).toHaveCount(1)
  await sidebarFeed(FEEDS.big.title).click()
  await openEntry(`${FEEDS.big.prefix} 5`)

  await expect(
    page.locator('.entry-content.text-accent\\/80').first(),
  ).toContainText(TRANSLATION_MARK)
  // Coming back to an article translated earlier shows the saved translation
  // without asking the AI again.
  await openEntry(`${FEEDS.big.prefix} 6`)
  await expect(
    page.locator('.entry-content.text-accent\\/80').first(),
  ).toContainText(TRANSLATION_MARK)
  const requestsBefore = upstream.translationRequests()
  await openEntry(`${FEEDS.big.prefix} 5`)
  await expect(
    page.locator('.entry-content.text-accent\\/80').first(),
  ).toContainText(TRANSLATION_MARK)
  expect(upstream.translationRequests()).toBe(requestsBefore)
})

test('auto summary skips short posts and runs for long articles', async () => {
  await page.evaluate(() =>
    window.api.settings.set({
      summary: { enabled: true, autoTrigger: true },
      translation: { enabled: false, autoTranslate: false },
    } as never),
  )
  await page.reload()
  await expect(page.locator('html[data-shortcuts-ready]')).toHaveCount(1)
  await sidebarFeed(FEEDS.small.title).click()
  const before = upstream.summaryRequests()

  await openEntry(`${FEEDS.small.prefix} 2`)
  await expect(readerTitle()).toHaveText(`${FEEDS.small.prefix} 2`)
  await page.waitForTimeout(1500)
  expect(upstream.summaryRequests()).toBe(before)

  await openEntry(`${FEEDS.small.prefix} 1`)
  await expect.poll(() => upstream.summaryRequests()).toBe(before + 1)
})

test('short feed text fetches the original quietly, full text does not', async () => {
  // Readability refuses the loopback fixture pages, so every fetch fails and
  // records readabilityError on the entry; that marks which entries it tried.
  await sidebarFeed(FEEDS.small.title).click()
  const ids = await page.evaluate(async () =>
    Object.fromEntries(
      (await window.api.entries.list({ limit: 200 })).entries.map((e) => [
        e.title,
        e.id,
      ]),
    ),
  )
  const triedFetch = (title: string) =>
    page.evaluate(
      async (id) => !!(await window.api.entries.get(id))?.readabilityError,
      ids[title],
    )
  const short = `${FEEDS.small.prefix} 3`
  const long = `${FEEDS.small.prefix} 1`

  await openEntry(long)
  await expect(readerTitle()).toHaveText(long)
  await openEntry(short)
  await expect.poll(() => triedFetch(short)).toBe(true)
  expect(await triedFetch(long)).toBe(false)
  // An automatic fetch that fails keeps the feed text without a banner.
  const getOriginal = page.getByTitle(/获取原文|Get Original/)
  await expect(getOriginal).toBeEnabled()
  await expect(page.getByText(/全文抓取失败|Full ?text/i)).toHaveCount(0)

  // Asking by hand still reports the failure.
  await getOriginal.click()
  await expect(page.getByText(/全文抓取失败|Full ?text/i)).toBeVisible()
})

test('the all view groups folders under their feed type', async () => {
  const articles = page.locator('[data-view-section="0"]')
  await expect(articles.locator('[data-folder="QA"]')).toHaveCount(1)
  // No tweet feeds, so no empty tweet section or default folder either.
  await expect(page.locator('[data-view-section="1"]')).toHaveCount(0)
  await expect(page.locator('[data-folder="推文"]')).toHaveCount(0)

  const feedRow = articles.locator('.sidebar-item', {
    hasText: FEEDS.small.title,
  })
  await articles.locator(':scope > button').click()
  await expect(feedRow).toHaveCount(0)
  await articles.locator(':scope > button').click()
  await expect(feedRow).toBeVisible()
})

test('dragging a folder header reorders folders and the order sticks', async () => {
  // A second (empty) article folder to reorder against.
  await page.evaluate(() =>
    localStorage.setItem(
      'livo-empty-folders',
      JSON.stringify([{ name: 'QB', view: 0 }]),
    ),
  )
  await page.reload()
  await expect(page.locator('html[data-shortcuts-ready]')).toHaveCount(1)
  const folderNames = () =>
    page
      .locator('[data-folder]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-folder')))
  const before = await folderNames()
  expect(before[0]).toBe('QA')
  const target = before[before.length - 1]!

  const grip = page.locator('[data-folder="QA"]').getByLabel('drag folder')
  const box = (await grip.boundingBox())!
  const dest = (await page
    .locator(`[data-folder="${target}"] > button`)
    .boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(dest.x + 20, dest.y + dest.height / 2, { steps: 8 })
  await page.mouse.up()

  const expected = [...before.slice(1), 'QA']
  await expect.poll(folderNames).toEqual(expected)
  await page.reload()
  await expect.poll(folderNames).toEqual(expected)
})

const folderHeader = (name: string) =>
  page.locator(`[data-folder="${name}"] > button`)

test('a collapsed folder stays collapsed after switching views', async () => {
  await folderHeader('QA').click()
  await expect(folderHeader('QA')).toHaveAttribute('aria-expanded', 'false')
  await page.locator('button[title="推文"]').click()
  await expect(folderHeader('QA')).toHaveCount(0)
  await page.locator('button[title="全部"]').click()
  await expect(folderHeader('QA')).toHaveAttribute('aria-expanded', 'false')
  await folderHeader('QA').click()
  await expect(folderHeader('QA')).toHaveAttribute('aria-expanded', 'true')
})

test('dragging a folder over a collapsed folder does not open it', async () => {
  const names = await page
    .locator('[data-folder]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-folder')))
  const other = names.find((name) => name !== 'QA')!
  await folderHeader(other).click()
  await expect(folderHeader(other)).toHaveAttribute('aria-expanded', 'false')

  const grip = (await page
    .locator('[data-folder="QA"]')
    .getByLabel('drag folder')
    .boundingBox())!
  const dest = (await folderHeader(other).boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(dest.x + 20, dest.y + dest.height / 2, { steps: 8 })
  await page.waitForTimeout(800)
  await expect(folderHeader(other)).toHaveAttribute('aria-expanded', 'false')
  await page.mouse.up()
  await folderHeader(other).click()
})

test('the collapse-all button folds and unfolds every folder', async () => {
  const states = () =>
    page
      .locator('[data-folder] > button, [data-view-section] > button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')))
  await page.locator('button[title="全部折叠"]').click()
  await expect.poll(states).not.toContain('true')
  await page.locator('button[title="全部展开"]').click()
  await expect.poll(states).not.toContain('false')
})

test('the reading progress bar animates without relayout', async () => {
  await sidebarFeed(FEEDS.small.title).click()
  await openEntry(`${FEEDS.small.prefix} 1`)
  await expect(readerTitle()).toHaveText(`${FEEDS.small.prefix} 1`)
  await readerTitle().evaluate((h1) => {
    let el = h1.parentElement
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    el!.scrollTop = el!.scrollHeight
  })
  const bar = page.getByRole('progressbar')
  await expect(bar).not.toHaveAttribute('aria-valuenow', '0')
  // Width (or `all`) transitions re-lay out the page on every scroll frame.
  expect(
    await bar.evaluate((el) => getComputedStyle(el).transitionProperty),
  ).toBe('transform')
})

test('scheduled digest makes the day digests once its time has passed', async () => {
  // Runs before the manual digest tests, so no digest exists for today yet.
  await page.evaluate(() =>
    window.api.settings.set({
      summary: { digestSchedule: true, digestTime: '00:00' },
    } as never),
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.api.ai.digest.listRuns(30)))
          .filter((run) => run.preset === 'today' && run.status === 'completed')
          .map((run) => run.title)
          .sort(),
      { timeout: 60_000 },
    )
    .toEqual(['今日简报', '今日简报 · QA'])
  await page.evaluate(() =>
    window.api.settings.set({ summary: { digestSchedule: false } } as never),
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

test('AI digest makes one report per folder', async () => {
  await page.getByLabel('简报范围').selectOption({ label: '每个分组各一份' })
  await page.getByRole('button', { name: '生成', exact: true }).click()
  // The fixture feeds all sit in the QA folder.
  await expect(
    page.getByRole('button', { name: /今日简报 · QA/ }).first(),
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('article').first()).toContainText('[1]')
})
