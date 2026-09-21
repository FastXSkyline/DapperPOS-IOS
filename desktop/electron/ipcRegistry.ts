// ---------------------------------------------------------------------------
// The registry of IPC handlers, shared between the process that registers them
// (main.ts) and the LAN server that executes them for remote terminals
// (syncServer's /rpc route).
//
// Its own module purely to break the import cycle: main.ts imports syncServer to
// start it, so syncServer cannot import main.ts to find the handlers.
//
// Registration happens through the interceptor in main.ts, which wraps
// `ipcMain.handle` once. That is what makes the allowlist trustworthy — the
// server's set of executable channels is derived from what was ACTUALLY
// registered, not from a hand-maintained list that would drift the first time
// somebody added a handler and forgot.
// ---------------------------------------------------------------------------

export type IpcHandler = (...args: any[]) => any

const handlers = new Map<string, IpcHandler>()

export const IpcRegistry = {
    register(channel: string, handler: IpcHandler): void {
        handlers.set(channel, handler)
    },

    get(channel: string): IpcHandler | undefined {
        return handlers.get(channel)
    },

    channels(): ReadonlySet<string> {
        return new Set(handlers.keys())
    },

    size(): number {
        return handlers.size
    },
}
