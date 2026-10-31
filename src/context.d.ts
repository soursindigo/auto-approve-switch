/**
 * Type augmentation for the members Cordis mixes onto a context at runtime.
 *
 * `@deepseek-ai/cordis` exposes `on`/`inject`/`effect`/`get` through the context
 * PROXY (they live on `ctx.events`, `ctx.registry` and the fiber), so they are
 * absent from the published `Context` type. The DSH packages call them directly
 * from JavaScript; this package is TypeScript, so the augmentation names them
 * here instead of standing in a whole fake `Context` (an earlier shim did that
 * and silently shadowed the shipped types).
 *
 * Everything not listed here — `Context` itself, `Events`, fibers — keeps the
 * real compiler types from the devDependency.
 *
 * @module auto-approve-switch/context
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Run an effect owned by this plugin's fiber.
     * @param execute - setup callback; a returned function tears the effect down.
     * @param label - diagnostics label.
     * @returns the disposer that tears the effect down early.
     */
    effect(execute: () => unknown, label?: string): () => void

    /**
     * Start a child fiber that waits until `services` are available.
     * @param services - required service names (an array, never an object: Cordis
     *                   reads an object's keys as service names).
     * @param callback - plugin body run once the services exist.
     * @returns the child fiber.
     */
    inject(services: readonly string[], callback: (ctx: Context) => unknown): unknown

    /**
     * Subscribe to an event. A waterfall listener answers instead of returning
     * `undefined`; returning `undefined` after calling `next()` leaves the
     * decision to the rest of the chain.
     * @param name - event name.
     * @param listener - listener body.
     * @param options - `{ prepend }` or a boolean shorthand.
     * @returns the unsubscribe function.
     */
    on(name: string, listener: (...args: any[]) => unknown, options?: unknown): () => void

    /**
     * Resolve an optional service without declaring it.
     * @param name - service name.
     * @returns the service, or `undefined`.
     */
    get<T = any>(name: string): T | undefined
  }
}
