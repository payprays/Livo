import { IPC } from '../../shared/types'
import { registerChannel } from '../ipc/register-channel'
import { toHandlerError } from '../ipc/handler-error'
import { getDb } from '../database'
import { fetchAndPersistReadableContent } from '../services/entry/readability-fetch'
import { ENTRY_FULLTEXT_FETCH_TASK } from '../services/system/task-contracts'
import { getLocalTaskRunner } from '../services/system/task-runner-service'

export function registerReadabilityHandlers(): void {
  registerChannel(IPC.READABILITY_FETCH, async (_event, url, entryId) => {
    const task = getLocalTaskRunner().enqueue(
      ENTRY_FULLTEXT_FETCH_TASK,
      { url, entryId },
      fetchAndPersistReadableContent,
      {
        metadata: {
          entryId,
          entryTaskKind: entryId ? 'fulltext' : undefined,
          url,
        },
      },
    )
    try {
      return { ...(await task.promise), runId: task.runId }
    } catch (error) {
      if (entryId) {
        getDb().entries.updateEntry(entryId, {
          readabilityError:
            error instanceof Error ? error.message : String(error),
        })
      }
      return toHandlerError(error, '无法获取原文')
    }
  })
}
