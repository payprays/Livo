import { BrowserWindow } from 'electron'

export interface EventBus {
  send(channel: string, ...args: unknown[]): void
}

export type EventSink = (channel: string, args: unknown[]) => void

const sinks = new Set<EventSink>()

/** Receives every event sent through the default bus (e.g. local API SSE clients). */
export function addEventSink(sink: EventSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/** Sends events to all open BrowserWindows and registered sinks. */
function createBrowserWindowEventBus(): EventBus {
  return {
    send(channel: string, ...args: unknown[]) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, ...args)
        }
      }
      for (const sink of sinks) sink(channel, args)
    },
  }
}

/** Singleton instance for use across main process services. */
let _instance: EventBus | null = null

export function getEventBus(): EventBus {
  if (!_instance) _instance = createBrowserWindowEventBus()
  return _instance
}

/** Convenience wrapper around `getEventBus().send` for the common (channel, payload) shape. */
export function sendToAllWindows(channel: string, payload: unknown): void {
  getEventBus().send(channel, payload)
}
