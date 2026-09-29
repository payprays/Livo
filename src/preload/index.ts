import { contextBridge, ipcRenderer } from 'electron'
import { unwrapIpcEnvelope } from '../shared/ipc-contracts'
import { createApi } from '../shared/api-factory'

const api = createApi({
  invoke: async (channel, ...args) =>
    unwrapIpcEnvelope(await ipcRenderer.invoke(channel, ...args)),
  on: (channel, handler) => {
    const listener = (_event: unknown, ...args: unknown[]) => handler(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  platform: process.platform,
})

export type ElectronAPI = ReturnType<typeof createApi>

contextBridge.exposeInMainWorld('api', api)
