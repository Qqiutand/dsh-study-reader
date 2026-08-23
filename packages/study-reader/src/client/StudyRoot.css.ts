/** Styles for the plugin-owned Study workspace root. */
export const STUDY_ROOT_CSS = `
.dsh-study-root,
.dsh-study-root * { box-sizing: border-box; }
.dsh-study-root { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; color: var(--dsw-alias-label-primary, #172033); font-family: var(--dsw-alias-font-family-base, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
.dsh-study-root-switcher { position: fixed; top: 8px; left: 50%; z-index: 3; display: flex; align-items: center; gap: 3px; padding: 4px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 94%, transparent); box-shadow: 0 5px 18px rgba(15, 23, 42, .14); pointer-events: auto; transform: translateX(-50%); backdrop-filter: blur(10px); }
.dsh-study-root-switcher button { min-width: 64px; border: 0; border-radius: 7px; padding: 7px 12px; background: transparent; color: var(--dsw-alias-label-secondary, #667085); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.dsh-study-root-switcher button:hover { background: var(--dsw-alias-interactive-bg-hover, #eef2f6); color: var(--dsw-alias-label-primary, #172033); }
.dsh-study-root-switcher button[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-active, #e8efff); color: var(--dsw-alias-state-business-primary, #315efb); }
.dsh-study-root-overlay { position: fixed; inset: 0; z-index: 1; padding-top: 52px; background: var(--dsw-alias-bg-base, #fff); pointer-events: auto; }
.dsh-study-root-overlay[hidden] { display: none; }
.dsh-study-root-workspace { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.dsh-study-error-boundary { display: grid; place-content: center; gap: 12px; min-height: 100%; padding: 32px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #172033); text-align: center; }
.dsh-study-error-boundary h2, .dsh-study-error-boundary p { margin: 0; }.dsh-study-error-boundary p { color: var(--dsw-alias-label-secondary, #667085); }.dsh-study-error-boundary details { max-width: 720px; text-align: left; }.dsh-study-error-boundary pre { overflow: auto; padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #eef2f6); }.dsh-study-error-boundary button { justify-self: center; padding: 8px 16px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: 8px; background: var(--dsw-alias-bg-base, #fff); color: inherit; cursor: pointer; }
.dsh-study-root-management { height: 100%; overflow: auto; padding: 82px clamp(24px, 7vw, 96px); background: var(--dsw-alias-bg-layer-2, #eef2f6); }
.dsh-study-root-management h2 { margin: 0 0 8px; }.dsh-study-root-management p { max-width: 680px; color: var(--dsw-alias-label-secondary, #667085); line-height: 1.6; }.dsh-study-root-management label { display: block; padding: 8px 0; }
@media (max-width: 760px) {
  .dsh-study-root-switcher { top: 5px; }
  .dsh-study-root-switcher button { min-width: 54px; padding-inline: 9px; }
  .dsh-study-root-overlay { padding-top: 48px; }
}
`

/** Stable class names shared by the Study root components. */
export const studyRootClass = {
  root: 'dsh-study-root',
  switcher: 'dsh-study-root-switcher',
  overlay: 'dsh-study-root-overlay',
  workspace: 'dsh-study-root-workspace',
  management: 'dsh-study-root-management',
} as const
