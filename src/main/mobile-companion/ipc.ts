import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { networkInterfaces } from 'node:os'
import { z } from 'zod'
import { IPC } from '../../shared/ipc'
import { MobileCompanion } from './server'

const empty = z.object({}).strict()
export function registerCompanionIpc(
  service: MobileCompanion,
  getWindow: () => BrowserWindow | null
): void {
  function register<T>(
    channel: string,
    schema: z.ZodType<T>,
    handler: (input: T) => unknown
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        if (event.sender !== getWindow()?.webContents) throw new Error('Untrusted sender')
        return { ok: true, data: await handler(schema.parse(payload)) }
      } catch {
        return { ok: false, error: 'Mobile companion operation failed' }
      }
    })
  }
  register(IPC.companionStatus, empty, () => service.status())
  register(IPC.companionStart, empty, () => service.start())
  register(IPC.companionStop, empty, async () => {
    await service.stop()
    return service.status()
  })
  register(IPC.companionRevoke, empty, () => service.revokeClients())
  register(
    IPC.companionRevokeClient,
    z.object({ clientId: z.string().regex(/^[A-Za-z0-9_-]{6,100}$/) }).strict(),
    ({ clientId }) => service.revokeClient(clientId)
  )
  register(
    IPC.companionRemoveRoot,
    z.object({ rootId: z.string().regex(/^[A-Za-z0-9_-]{6,100}$/) }).strict(),
    ({ rootId }) => service.removeRoot(rootId)
  )
  register(IPC.companionClearRoots, empty, () => service.clearRoots())
  register(
    IPC.companionApproveRoot,
    z.object({ role: z.enum(['source', 'target']) }).strict(),
    async ({ role }) => {
      const options = { properties: ['openDirectory'] as ['openDirectory'] }
      const window = getWindow()
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return service.status()
      return service.approveRoot(result.filePaths[0], role)
    }
  )
  register(IPC.companionPairing, empty, () => {
    const addresses = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((item) => item.family === 'IPv4' && !item.internal)
    const address = addresses.find((item) =>
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address)
    )?.address
    if (!address) throw new Error('Local network unavailable')
    return service.createPairing(address)
  })
}
