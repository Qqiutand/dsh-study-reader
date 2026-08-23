/** Styles injected by the MinerU credential settings page. */
export const MINERU_SETTINGS_CSS = `
.dsh-study-settings-page { box-sizing:border-box; height:100%; overflow:auto; padding:28px clamp(20px,4vw,56px) 48px; color:var(--dsw-alias-label-primary); scrollbar-gutter:stable; }
.dsh-study-settings-heading { margin-bottom: 24px; }
.dsh-study-settings-eyebrow { margin: 0 0 8px; color: var(--dsw-alias-label-caption); font-size: 11px; font-weight: 650; letter-spacing: 0.12em; }
.dsh-study-settings-heading h2 { margin: 0; font-size: 26px; font-weight: 560; }
.dsh-study-settings-heading > p:last-child { max-width: 600px; margin: 10px 0 0; color: var(--dsw-alias-label-secondary); line-height: 1.65; }
.dsh-study-settings-layout{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,760px);align-items:start;gap:16px;max-width:1060px}
.dsh-study-settings-connection-list,.dsh-study-settings-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-study-settings-connection-list{position:sticky;top:0;overflow:hidden}.dsh-study-settings-connection-list>header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh-study-settings-connection-list h3,.dsh-study-settings-connection-list p{margin:0}.dsh-study-settings-connection-list p{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-study-settings-connection-list header button{padding:7px 9px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:7px;background:transparent;color:var(--dsw-alias-state-business-primary);cursor:pointer}.dsh-study-settings-connection-rows{max-height:min(560px,calc(100vh - 250px));overflow-y:auto;padding:8px}.dsh-study-settings-connection-rows>button{width:100%;display:grid;gap:4px;margin-bottom:6px;padding:11px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}.dsh-study-settings-connection-rows>button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-study-settings-connection-rows>button[aria-current=page]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}.dsh-study-settings-connection-rows span{overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsh-study-settings-connection-rows small{color:var(--dsw-alias-state-business-primary)}
.dsh-study-settings-detail{min-width:0}.dsh-study-settings-card { padding:22px; }
.dsh-study-settings-card-head, .dsh-study-settings-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dsh-study-settings-card-head { margin-bottom: 22px; }
.dsh-study-settings-card-head h3 { margin: 0; font-size: 17px; }
.dsh-study-settings-card-head p { margin: 4px 0 0; color: var(--dsw-alias-label-caption); font-size: 13px; }
.dsh-study-settings-card dl { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 8px; margin: 0 0 20px; }
.dsh-study-settings-card dl div { min-width: 0; padding: 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dsh-study-settings-card dt { color: var(--dsw-alias-label-caption); font-size: 11px; }
.dsh-study-settings-card dd { overflow-wrap: anywhere; margin: 3px 0 0; font-size: 12px; }
.dsh-study-settings-configured, .dsh-study-settings-unconfigured { padding: 4px 8px; border-radius: 999px; font-size: 12px; }
.dsh-study-settings-configured { color: var(--dsw-alias-state-success); background: var(--dsw-alias-bg-layer-2); }
.dsh-study-settings-unconfigured { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsh-study-settings-label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.dsh-study-settings-input { box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: inherit; }
.dsh-study-settings-input:focus { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh-study-settings-card fieldset{display:grid;gap:12px;margin:0;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dsh-study-settings-card legend{padding:0 6px;font-weight:700}.dsh-study-settings-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.dsh-study-settings-checks{display:flex;flex-wrap:wrap;gap:10px 18px}.dsh-study-settings-key-section{margin-top:18px;padding-top:17px;border-top:1px solid var(--dsw-alias-border-l2)}.dsh-study-settings-key-section h4{margin:0 0 10px}
.dsh-study-settings-hint { margin: 8px 0 0; color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 1.5; }
.dsh-study-settings-error { margin: 12px 0 0; color: var(--dsw-alias-state-danger); font-size: 13px; }
.dsh-study-settings-actions { justify-content: flex-start; margin-top: 20px; }
.dsh-study-settings-save, .dsh-study-settings-refresh { border-radius: 8px; padding: 8px 13px; font: inherit; font-size: 13px; cursor: pointer; }
.dsh-study-settings-save { border: 0; color: var(--dsw-alias-bg-base); background: var(--dsw-alias-state-business-primary); }
.dsh-study-settings-refresh { border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); background: transparent; }
.dsh-study-settings-danger{border:1px solid var(--dsw-alias-state-danger);border-radius:8px;padding:8px 13px;background:transparent;color:var(--dsw-alias-state-danger);font:inherit;font-size:13px;cursor:pointer}
.dsh-study-settings-save:disabled, .dsh-study-settings-refresh:disabled, .dsh-study-settings-input:disabled { cursor: not-allowed; opacity: 0.55; }
@media(max-width:820px){.dsh-study-settings-page{padding:18px 14px 40px}.dsh-study-settings-layout{grid-template-columns:1fr}.dsh-study-settings-connection-list{position:static}.dsh-study-settings-connection-rows{max-height:220px}.dsh-study-settings-form-grid{grid-template-columns:1fr}}
`

/** Names for every rule in {@link MINERU_SETTINGS_CSS}. */
export const minerUSettingsClass = {
  page:'dsh-study-settings-page', heading:'dsh-study-settings-heading', eyebrow:'dsh-study-settings-eyebrow', layout:'dsh-study-settings-layout', connectionList:'dsh-study-settings-connection-list', connectionRows:'dsh-study-settings-connection-rows', detail:'dsh-study-settings-detail', card:'dsh-study-settings-card', cardHead:'dsh-study-settings-card-head', configured:'dsh-study-settings-configured', unconfigured:'dsh-study-settings-unconfigured', label:'dsh-study-settings-label', input:'dsh-study-settings-input', formGrid:'dsh-study-settings-form-grid', checks:'dsh-study-settings-checks', keySection:'dsh-study-settings-key-section', hint:'dsh-study-settings-hint', error:'dsh-study-settings-error', actions:'dsh-study-settings-actions', save:'dsh-study-settings-save', refresh:'dsh-study-settings-refresh', danger:'dsh-study-settings-danger',
} as const
