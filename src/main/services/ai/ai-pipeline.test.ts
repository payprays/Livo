import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIDigestRun } from '../../../shared/types'
import { generateAIDigest, runAISummarizeTask } from './ai-pipeline'
import { runAICompletion } from './ai-completion'

const getDbMock = vi.hoisted(() => vi.fn())
const settingsProviderGetMock = vi.hoisted(() => vi.fn())
const validateAIConfigMock = vi.hoisted(() => vi.fn())
const createOpenAIClientMock = vi.hoisted(() => vi.fn())
const createCompletionMock = vi.hoisted(() => vi.fn())
const eventSendMock = vi.hoisted(() => vi.fn())
const fetchReadableMock = vi.hoisted(() => vi.fn())

vi.mock('../entry/readability-fetch', () => ({
  fetchAndPersistReadableContent: fetchReadableMock,
}))

vi.mock('../../database', () => ({
  getDb: getDbMock,
}))

vi.mock('../system/settings-provider', () => ({
  settingsProvider: { get: settingsProviderGetMock },
}))

vi.mock('./ai-client', () => ({
  validateAIConfig: validateAIConfigMock,
  createOpenAIClient: createOpenAIClientMock,
}))

vi.mock('../system/event-bus', () => ({
  getEventBus: () => ({ send: eventSendMock }),
  sendToAllWindows: (channel: string, payload: unknown) =>
    eventSendMock(channel, payload),
}))

function makeDigestRun(overrides: Partial<AIDigestRun> = {}): AIDigestRun {
  return {
    id: 'digest-1',
    preset: 'today',
    title: '今日简报',
    status: 'running',
    windowStartAt: 1000,
    windowEndAt: 2000,
    sourceEntryIds: [],
    candidateCount: 2,
    content: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('generateAIDigest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsProviderGetMock.mockReturnValue({
      ai: {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: 'deepseek-v4-pro',
        baseUrl: '',
      },
    })
    validateAIConfigMock.mockReturnValue(null)
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: createCompletionMock,
        },
      },
    })
    createCompletionMock
      .mockResolvedValueOnce({
        choices: [{ message: { content: '我会选择 entry-1 作为重点候选。' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '- 重点（entry-1）' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '# 今日简报\n\n- 重点（entry-1）' } }],
      })

    let run = makeDigestRun()
    getDbMock.mockReturnValue({
      digests: {
        getDigestWindow: vi.fn(() => ({
          windowStartAt: 1000,
          windowEndAt: 2000,
        })),
        listDigestCandidates: vi.fn(() => [
          {
            id: 'entry-1',
            title: '第一篇',
            summary: '第一篇正文 '.repeat(100),
            feedTitle: '科技',
            publishedAt: 1900,
          },
          {
            id: 'entry-2',
            title: '第二篇',
            summary: '第二篇正文 '.repeat(100),
            feedTitle: '科技',
            publishedAt: 1800,
          },
        ]),
        upsertAIDigestRun: vi.fn((input) => {
          run = makeDigestRun(input)
          return run
        }),
        updateAIDigestRun: vi.fn((_id, updates) => {
          run = { ...run, ...updates, updatedAt: run.updatedAt + 1 }
          return run
        }),
      },
    })
  })

  it('disables DeepSeek thinking for every digest chat completion', async () => {
    const result = await generateAIDigest({ preset: 'today' })

    expect(result.success).toBe(true)
    expect(createCompletionMock).toHaveBeenCalled()
    for (const [payload] of createCompletionMock.mock.calls) {
      expect(payload.thinking).toEqual({ type: 'disabled' })
    }
  })

  it('uses every candidate without asking the AI to pick when they fit', async () => {
    createCompletionMock.mockReset()
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: '- 要点' } }],
    })
    const result = await generateAIDigest({ preset: 'today' })

    const prompts = createCompletionMock.mock.calls.map(([payload]) =>
      JSON.stringify(payload.messages),
    )
    expect(prompts.some((p) => p.includes('候选集筛选器'))).toBe(false)
    expect(result.success && result.run.sourceEntryIds).toEqual([
      'entry-1',
      'entry-2',
    ])
  })

  it('lets the AI rank candidates and takes them up to the token budget', async () => {
    // 200 long Chinese articles: far more than 256k tokens in total.
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      title: `文章 ${i}`,
      content: '云安全'.repeat(3000),
      publishedAt: 1000 + i,
    }))
    getDbMock().digests.listDigestCandidates = vi.fn(() => many)
    const ranked = many.map((c) => c.id).reverse()
    createCompletionMock.mockReset()
    createCompletionMock.mockImplementation(async ({ messages }) => ({
      choices: [
        {
          message: {
            content: JSON.stringify(messages).includes('候选集筛选器')
              ? JSON.stringify({ ids: ranked })
              : '- 要点',
          },
        },
      ],
    }))

    const result = await generateAIDigest({ preset: 'today' })
    const ids = result.success ? result.run.sourceEntryIds : []
    // Taken in the AI's order, as many as fit: ~8000 chars (~5.6k tokens) each.
    expect(ids.length).toBeGreaterThan(20)
    expect(ids.length).toBeLessThan(60)
    // The AI ranked newest-numbered first; the pick keeps that order.
    const num = (id: string) => Number(id.slice(1))
    expect(ids).toEqual([...ids].sort((x, y) => num(y) - num(x)))
  })

  // Two small candidates fit the budget, so there is no ranking call and the
  // first call is the batch prompt.
  function digestWith(candidates: object[]) {
    const db = getDbMock()
    db.digests.listDigestCandidates = vi.fn(() => candidates)
    createCompletionMock.mockReset()
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: '- 要点' } }],
    })
    return () => JSON.stringify(createCompletionMock.mock.calls[0][0].messages)
  }
  const other = { id: 'other', title: '其他', summary: '其他', publishedAt: 1 }

  it('fetches the original for picked articles with little text', async () => {
    fetchReadableMock.mockReset()
    fetchReadableMock.mockResolvedValue({
      success: true,
      content: `<p>${'原文全文 '.repeat(200)}</p>`,
    })
    const batchPrompt = digestWith([
      {
        id: 'entry-1',
        title: '短文',
        summary: '只有一句摘要',
        content: '只有一句摘要',
        url: 'https://example.com/a',
        feedView: 0,
        publishedAt: 1900,
      },
      other,
    ])

    expect((await generateAIDigest({ preset: 'today' })).success).toBe(true)
    expect(fetchReadableMock).toHaveBeenCalledWith({
      url: 'https://example.com/a',
      entryId: 'entry-1',
    })
    expect(batchPrompt()).toContain('原文全文')
  })

  it('keeps tweets as they are and prefers the full feed text over its excerpt', async () => {
    fetchReadableMock.mockReset()
    const tweet = digestWith([
      {
        id: 'entry-1',
        title: '推文',
        summary: '一条推文',
        content: '一条推文',
        url: 'https://x.com/a/status/1',
        feedView: 1,
        publishedAt: 1900,
      },
      other,
    ])
    await generateAIDigest({ preset: 'today' })
    expect(fetchReadableMock).not.toHaveBeenCalled()
    expect(tweet()).toContain('一条推文')

    const article = digestWith([
      {
        id: 'entry-1',
        title: '全文',
        summary: '简短摘要',
        content: 'RSS 全文 '.repeat(200),
        url: 'https://example.com/b',
        feedView: 0,
        publishedAt: 1900,
      },
      other,
    ])
    await generateAIDigest({ preset: 'today' })
    expect(fetchReadableMock).not.toHaveBeenCalled()
    expect(article()).toContain('RSS 全文')
  })
})

describe('runAISummarizeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsProviderGetMock.mockReturnValue({
      ai: {
        provider: 'openai',
        apiKey: 'test-key',
        model: 'gpt-test',
        baseUrl: '',
        summaryPrompt: '',
      },
      general: { language: 'zh-CN' },
    })
    validateAIConfigMock.mockReturnValue(null)
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: createCompletionMock,
        },
      },
    })
  })

  it('persists running draft and succeeded states for streamed summary sessions', async () => {
    const updateSession = vi.fn()
    const updateEntry = vi.fn()
    getDbMock.mockReturnValue({
      aiSummarySessions: { updateSession },
      entries: { updateEntry },
    })
    async function* stream() {
      yield { choices: [{ delta: { content: '摘要' } }] }
      yield { choices: [{ delta: { content: '内容' } }] }
    }
    createCompletionMock.mockResolvedValueOnce(stream())

    await expect(
      runAISummarizeTask(
        {
          content: 'article content',
          language: 'zh-CN',
          requestId: 'request-1',
          entryId: 'entry-1',
          sessionId: 'session-1',
          sourceHash: 'hash-1',
        },
        {
          runId: 'run-1',
          taskName: 'entry.ai_summary',
          reportProgress: vi.fn(),
        },
      ),
    ).resolves.toEqual({ success: true, summary: '摘要内容' })

    expect(updateSession.mock.calls.map(([, patch]) => patch)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'running',
          model: 'gpt-test',
          sourceHash: 'hash-1',
          runId: 'run-1',
        }),
        expect.objectContaining({
          status: 'running',
          draftText: '摘要',
        }),
        expect.objectContaining({
          status: 'running',
          draftText: '摘要内容',
        }),
        expect.objectContaining({
          status: 'succeeded',
          draftText: '摘要内容',
          finalText: '摘要内容',
          errorCode: undefined,
          errorMessage: undefined,
          rawErrorMessage: undefined,
        }),
      ]),
    )
    expect(updateEntry).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({
        aiSummary: '摘要内容',
        aiSummaryError: undefined,
      }),
    )
    expect(eventSendMock).toHaveBeenCalledWith('ai:summary-stream-chunk', {
      requestId: 'request-1',
      content: '摘要',
    })
    expect(eventSendMock).toHaveBeenCalledWith('ai:summary-stream-done', {
      requestId: 'request-1',
    })
  })

  it('persists failed summary session state when AI config is invalid', async () => {
    const updateSession = vi.fn()
    const updateEntry = vi.fn()
    getDbMock.mockReturnValue({
      aiSummarySessions: { updateSession },
      entries: { updateEntry },
    })
    validateAIConfigMock.mockReturnValueOnce('No API key')

    await expect(
      runAISummarizeTask({
        content: 'article content',
        language: 'zh-CN',
        entryId: 'entry-1',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('No API key')

    expect(updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        status: 'failed',
        errorCode: 'provider_error',
        errorMessage: 'No API key',
        rawErrorMessage: 'No API key',
      }),
    )
  })
})

describe('runAICompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateAIConfigMock.mockReturnValue(null)
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: createCompletionMock,
        },
      },
    })
  })

  it('owns the streaming event protocol for chat-style completions', async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: 'hello ' } }] }
      yield { choices: [{ delta: { content: 'world' } }] }
    }
    createCompletionMock.mockResolvedValueOnce(stream())
    const sendEvent = vi.fn()

    await expect(
      runAICompletion({
        aiConfig: {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-test',
        },
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.7,
        maxTokens: 100,
        requestId: 'chat-request',
        eventPrefix: 'ai:chat',
        sendEvent,
      }),
    ).resolves.toBe('hello world')

    expect(sendEvent.mock.calls).toEqual([
      [
        'ai:chat-stream-chunk',
        { requestId: 'chat-request', content: 'hello ' },
      ],
      ['ai:chat-stream-chunk', { requestId: 'chat-request', content: 'world' }],
      ['ai:chat-stream-done', { requestId: 'chat-request' }],
    ])
  })

  it('retries empty non-streaming completions with rebuilt messages', async () => {
    createCompletionMock
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] })

    await expect(
      runAICompletion({
        aiConfig: {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-test',
        },
        messages: (attempt) => [{ role: 'user', content: `try-${attempt}` }],
        temperature: 0,
        maxTokens: 100,
        eventPrefix: 'ai:summary',
        sendEvent: vi.fn(),
      }),
    ).resolves.toBe('ok')

    expect(
      createCompletionMock.mock.calls.map(([payload]) => payload.messages),
    ).toEqual([
      [{ role: 'user', content: 'try-0' }],
      [{ role: 'user', content: 'try-1' }],
    ])
  })
})
