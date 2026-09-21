import { useEffect, useRef } from 'react'
import type { RetailEventType } from '../vite-env'

/**
 * Re-run `reload` when something relevant changes anywhere in this store.
 *
 * WHY DEBOUNCED. A single sale publishes both `sale.created` and
 * `inventory.updated`; an exchange publishes three events; a transfer publishes
 * four. Reloading per event would fire the same queries several times within a
 * few milliseconds and make the table flicker. Collapsing to one reload per burst
 * costs a fraction of a second of staleness and saves the redundant work.
 *
 * WHY RELOAD AT ALL, RATHER THAN PATCHING STATE FROM THE PAYLOAD. Event payloads
 * carry identifiers, not values (see electron/eventBus.ts). Applying a delta from
 * a message would drift the moment one is missed; re-reading is always correct and
 * a screen refresh is cheap against a local SQLite file.
 *
 * `storeId` null means "every store" — the owner's cross-store view wants all of
 * them. A store-scoped screen ignores other shops' traffic so a busy Casual till
 * does not keep re-rendering Costume's stock table.
 */
export function useRetailEvents(
    types: RetailEventType[],
    reload: () => void,
    options: { storeId?: number | null; delay?: number } = {},
) {
    const { storeId = null, delay = 250 } = options

    // Refs, so a caller passing an inline arrow does not tear down and rebuild the
    // subscription on every render.
    const reloadRef = useRef(reload)
    const typesRef = useRef(types)

    // Written in an effect, not during render: React may render a component more
    // than once before committing, and a ref mutated on a discarded render would
    // leave the subscription pointing at a callback that was never mounted.
    useEffect(() => {
        reloadRef.current = reload
        typesRef.current = types
    })

    useEffect(() => {
        const bridge = window.electron?.realtime
        if (!bridge?.onEvent) return

        let timer: ReturnType<typeof setTimeout> | null = null

        const off = bridge.onEvent(event => {
            if (!typesRef.current.includes(event.type)) return
            // A global event (storeId null) always applies; otherwise it must match
            // the store this screen is showing.
            if (storeId !== null && event.storeId !== null && event.storeId !== storeId) return

            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
                timer = null
                reloadRef.current()
            }, delay)
        })

        return () => {
            if (timer) clearTimeout(timer)
            off?.()
        }
    }, [storeId, delay])
}
