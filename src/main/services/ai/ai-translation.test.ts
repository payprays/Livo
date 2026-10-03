import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryAITranslationSession } from '../../../shared/types'
import { isInTargetLanguage, translateEntrySegments } from './ai-translation'

const getDbMock = vi.hoisted(() => vi.fn())
const settingsProviderGetMock = vi.hoisted(() => vi.fn())
const runAITranslateTaskMock = vi.hoisted(() => vi.fn())
const sendEventMock = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getDb: getDbMock,
}))

vi.mock('../system/settings-provider', () => ({
  settingsProvider: { get: settingsProviderGetMock },
}))

vi.mock('../system/event-bus', () => ({
  getEventBus: () => ({ send: sendEventMock }),
}))

vi.mock('./ai-pipeline', () => ({
  runAITranslateTask: runAITranslateTaskMock,
}))

function makeSession(
  overrides: Partial<EntryAITranslationSession> = {},
): EntryAITranslationSession {
  return {
    id: 'session-1',
    entryId: 'entry-1',
    targetLanguage: 'zh-CN',
    status: 'running',
    segments: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function mockDb(initialSession: EntryAITranslationSession | null = null) {
  let session = initialSession
  const repo = {
    getLatestSessionByEntryId: vi.fn(() => session),
    createSession: vi.fn((input) => {
      session = makeSession({
        entryId: input.entryId,
        targetLanguage: input.targetLanguage,
        status: input.status,
        segments: input.segments,
        model: input.model,
        configFingerprint: input.configFingerprint,
      })
      return session
    }),
    updateSession: vi.fn((_id, updates) => {
      if (!session) return null
      session = { ...session, ...updates, updatedAt: Date.now() }
      return session
    }),
    getSessionById: vi.fn(() => session),
  }
  getDbMock.mockReturnValue({ aiTranslationSessions: repo })
  return repo
}

describe('translateEntrySegments', () => {
  beforeEach(() => {
    getDbMock.mockReset()
    settingsProviderGetMock.mockReset()
    runAITranslateTaskMock.mockReset()
    settingsProviderGetMock.mockReturnValue({
      ai: {
        provider: 'openai',
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
  })

  it('translates runnable paragraphs and persists segment state', async () => {
    const repo = mockDb()
    runAITranslateTaskMock.mockResolvedValue({
      success: true,
      translation: '你好世界',
    })

    const result = await translateEntrySegments({
      entryId: 'entry-1',
      paragraphs: ['hello world', 'x'],
      targetLanguage: 'zh-CN',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.translatedParagraphs).toEqual(['你好世界', ''])
    expect(result.errorMap).toEqual({})
    expect(result.session.status).toBe('succeeded')
    expect(result.session.segments[0]).toMatchObject({
      index: 0,
      translatedText: '你好世界',
      status: 'succeeded',
    })
    expect(result.session.segments[1]).toMatchObject({
      index: 1,
      translatedText: '',
      status: 'skipped',
    })
    expect(runAITranslateTaskMock).toHaveBeenCalledTimes(1)
    expect(repo.createSession).toHaveBeenCalledTimes(1)
  })

  it('retries requested indexes while preserving existing translations', async () => {
    mockDb(
      makeSession({
        segments: [
          {
            index: 0,
            sourceText: 'hello world',
            translatedText: '旧翻译',
            status: 'succeeded',
          },
          {
            index: 1,
            sourceText: 'second paragraph',
            translatedText: '',
            status: 'failed',
            errorMessage: 'old error',
          },
        ],
      }),
    )
    runAITranslateTaskMock.mockResolvedValue({
      success: true,
      translation: '第二段',
    })

    const result = await translateEntrySegments({
      entryId: 'entry-1',
      paragraphs: ['hello world', 'second paragraph'],
      targetLanguage: 'zh-CN',
      indexes: [1],
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.translatedParagraphs).toEqual(['旧翻译', '第二段'])
    expect(result.errorMap).toEqual({})
    expect(runAITranslateTaskMock).toHaveBeenCalledTimes(1)
    expect(runAITranslateTaskMock).toHaveBeenCalledWith({
      content: 'second paragraph',
      targetLanguage: 'zh-CN',
    })
  })

  it('marks the session config_changed when settings change during translation', async () => {
    mockDb()
    settingsProviderGetMock
      .mockReturnValueOnce({
        ai: {
          provider: 'openai',
          apiKey: 'key-a',
          model: 'test-model',
        },
      })
      .mockReturnValueOnce({
        ai: {
          provider: 'openai',
          apiKey: 'key-a',
          model: 'test-model',
        },
      })
      .mockReturnValue({
        ai: {
          provider: 'openai',
          apiKey: 'key-b',
          model: 'test-model',
        },
      })

    const result = await translateEntrySegments({
      entryId: 'entry-1',
      paragraphs: ['hello world'],
      targetLanguage: 'zh-CN',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.session).toMatchObject({
      status: 'config_changed',
      errorCode: 'config_changed',
      errorMessage: 'AI 配置已变更，翻译已中止',
    })
    expect(result.errorMap).toEqual({
      0: 'AI 配置已变更，翻译已中止',
    })
    expect(result.session.segments[0]).toMatchObject({
      index: 0,
      status: 'failed',
      errorMessage: 'AI 配置已变更，翻译已中止',
    })
    expect(runAITranslateTaskMock).not.toHaveBeenCalled()
  })

  it('skips paragraphs already in the target language', async () => {
    mockDb()
    runAITranslateTaskMock.mockResolvedValue({
      success: true,
      translation: '译文',
    })

    const result = await translateEntrySegments({
      entryId: 'entry-1',
      targetLanguage: 'zh-CN',
      paragraphs: [
        '<p>这一段本来就是中文，不需要翻译。</p>',
        '<p>An English paragraph.</p>',
      ],
    })

    expect(runAITranslateTaskMock).toHaveBeenCalledTimes(1)
    expect(result.success && result.translatedParagraphs).toEqual(['', '译文'])
    expect(result.success && result.session?.segments[0].status).toBe('skipped')
  })

  it('does not re-request paragraphs translated earlier and reports progress', async () => {
    mockDb()
    runAITranslateTaskMock.mockResolvedValue({
      success: true,
      translation: '译文',
    })
    const input = {
      entryId: 'entry-1',
      targetLanguage: 'zh-CN',
      paragraphs: [
        '<p>First paragraph here.</p>',
        '<p>Second paragraph here.</p>',
      ],
    }

    await translateEntrySegments(input)
    expect(sendEventMock).toHaveBeenCalledWith(
      'ai:translation-progress',
      expect.objectContaining({ entryId: 'entry-1', translation: '译文' }),
    )
    runAITranslateTaskMock.mockClear()
    await translateEntrySegments(input)

    expect(runAITranslateTaskMock).not.toHaveBeenCalled()
  })

  it('stops an older run once a newer one starts', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    runAITranslateTaskMock.mockImplementation(async () => {
      await gate
      return { success: true, translation: '译文' }
    })
    mockDb()
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `<p>Paragraph ${i} text.</p>`,
    )
    const older = translateEntrySegments({
      entryId: 'old',
      targetLanguage: 'zh-CN',
      paragraphs,
    })
    mockDb()
    const newer = translateEntrySegments({
      entryId: 'new',
      targetLanguage: 'zh-CN',
      paragraphs: ['<p>Only paragraph.</p>'],
    })
    release()
    const [oldResult] = await Promise.all([older, newer])

    // 30 + 1 paragraphs, but the old run only finished its first wave of 10.
    expect(runAITranslateTaskMock).toHaveBeenCalledTimes(11)
    expect(oldResult.success && oldResult.session?.errorCode).toBe('superseded')
  })
})

describe('translateEntrySegments skip rules', () => {
  beforeEach(() => {
    runAITranslateTaskMock.mockReset()
    settingsProviderGetMock.mockReturnValue({
      ai: { provider: 'openai', apiKey: 'k', model: 'm' },
    })
  })

  it('leaves table of contents links and short headings untranslated', async () => {
    mockDb()
    runAITranslateTaskMock.mockResolvedValue({
      success: true,
      translation: '译文',
    })
    const paragraphs = [
      '<li><a href="#lab-demonstration" class="x"><span>Lab Demonstration</span></a></li>',
      '<div><nav><ol><li><a href="#introduction"><span>Introduction</span></a></li>',
      '<h2 id="intro"><span>Introduction</span></h2>',
      '<p class="x"><span><strong><span>Table of contents</span></strong></span></p>',
      '<p><strong>Note:</strong> rotate the recovery keys afterwards.</p>',
      '<h2>How attackers turn BitLocker recovery into an attack vector</h2>',
      '<p>Read <a href="https://example.com">the report</a> before patching.</p>',
    ]

    const result = await translateEntrySegments({
      entryId: 'entry-1',
      targetLanguage: 'zh-CN',
      paragraphs,
    })

    expect(
      result.success && result.session?.segments.map((s) => s.status),
    ).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'succeeded',
      'succeeded',
      'succeeded',
    ])
  })
})

describe('isInTargetLanguage', () => {
  it('tells CJK scripts apart', () => {
    expect(isInTargetLanguage('这是中文段落', 'zh-CN')).toBe(true)
    expect(isInTargetLanguage('Kubernetes 的 RBAC 权限模型', 'zh-CN')).toBe(
      true,
    )
    expect(isInTargetLanguage('これは日本語の文章です', 'zh-CN')).toBe(false)
    expect(isInTargetLanguage('これは日本語の文章です', 'ja')).toBe(true)
    expect(isInTargetLanguage('An English sentence', 'zh-CN')).toBe(false)
    expect(isInTargetLanguage('An English sentence', 'en')).toBe(false)
  })
})
