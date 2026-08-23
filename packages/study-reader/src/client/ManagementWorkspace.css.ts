/** Scoped styles for Bookroom's local management panels. */
export const MANAGEMENT_WORKSPACE_CSS = `
.dsh-study-management { height:100%; overflow:auto; padding:78px clamp(20px,5vw,72px) 32px; background:var(--dsw-alias-bg-layer-2,#eef2f6); }
.dsh-study-management-shell { max-width:1100px; margin:auto; }
.dsh-study-management-header { display:flex; align-items:start; justify-content:space-between; gap:16px; margin-bottom:16px; }
.dsh-study-management h2 { margin:0; font-size:22px; }.dsh-study-management p { color:var(--dsw-alias-label-secondary,#667085); line-height:1.55; }
.dsh-study-management-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:12px; }
.dsh-study-skill-explorer { height:min(720px,calc(100vh - 210px)); min-height:360px; display:grid; grid-template-columns:minmax(230px,300px) minmax(0,1fr); overflow:hidden; border:1px solid var(--dsw-alias-border-l2,#dfe4eb); border-radius:12px; background:var(--dsw-alias-bg-base,#fff); }
.dsh-study-skill-list { min-width:0; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; border-right:1px solid var(--dsw-alias-border-l2,#dfe4eb); background:var(--dsw-alias-bg-layer-1,#f8fafc); }
.dsh-study-management .dsh-study-skill-list>button { width:100%; display:grid; gap:5px; padding:13px 14px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2,#e8ecf1); border-radius:0; background:transparent; text-align:left; }
.dsh-study-skill-list>button strong { font-size:13px; }.dsh-study-skill-list>button small { overflow:hidden; color:var(--dsw-alias-label-secondary,#667085); text-overflow:ellipsis; white-space:nowrap; }.dsh-study-skill-list>button span { color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; }
.dsh-study-management .dsh-study-skill-list>button[aria-current=page] { box-shadow:inset 3px 0 var(--dsw-alias-state-business-primary,#4f8cff); background:var(--dsw-alias-interactive-bg-active,#edf4ff); }
.dsh-study-skill-detail { min-width:0; overflow:auto; padding:18px; }.dsh-study-skill-detail>.dsh-study-management-card,.dsh-study-skill-detail>.dsh-study-management-editor { border:0; padding:0; }
.dsh-study-management-card,.dsh-study-management-editor,.dsh-study-management-proposals { border:1px solid var(--dsw-alias-border-l2,#dfe4eb); border-radius:12px; background:var(--dsw-alias-bg-base,#fff); padding:15px; }
.dsh-study-management-card h3 { margin:0 0 6px; font-size:15px; }.dsh-study-management-meta { display:flex; flex-wrap:wrap; gap:6px; color:var(--dsw-alias-label-secondary,#667085); font-size:12px; }
.dsh-study-management-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }.dsh-study-management button { border:1px solid var(--dsw-alias-border-l2,#d0d5dd); border-radius:7px; padding:6px 10px; background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#172033); font:inherit; font-size:12px; cursor:pointer; }.dsh-study-management button:disabled { cursor:not-allowed; opacity:.55; }
.dsh-study-management-skill-index-group { flex:1 0 100%; display:grid; gap:10px; margin:4px 0; }
.dsh-study-management-skill-index-header { display:flex; align-items:end; justify-content:space-between; gap:12px; }
.dsh-study-management-skill-index-header > button span { margin-left:6px; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,#eef2f6); color:var(--dsw-alias-label-secondary,#667085); }
.dsh-study-management-skill-index-header label { display:flex; align-items:center; gap:7px; min-width:min(360px,50%); font-size:12px; color:var(--dsw-alias-label-secondary,#667085); }
.dsh-study-management-skill-index { display:grid; grid-template-columns:repeat(auto-fit,minmax(245px,1fr)); gap:9px; }
.dsh-study-management .dsh-study-management-skill-index-item { display:grid; align-content:start; gap:5px; min-height:112px; padding:12px; text-align:left; border-radius:10px; }
.dsh-study-management-skill-index-item strong { font-size:13px; line-height:1.3; }
.dsh-study-management-skill-index-item small { color:var(--dsw-alias-label-secondary,#667085); line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dsh-study-management-skill-index-item > span { color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; line-height:1.35; }
.dsh-study-management-skill-index-item[aria-pressed="true"] { border-color:var(--dsw-alias-primary,#4f8cff); box-shadow:0 0 0 1px var(--dsw-alias-primary,#4f8cff); }
@media (max-width:720px) { .dsh-study-management-skill-index-header { align-items:stretch; flex-direction:column; }.dsh-study-management-skill-index-header label { min-width:100%; }.dsh-study-management-skill-index { grid-template-columns:1fr; } }
@media (max-width:860px) { .dsh-study-skill-explorer { height:auto; min-height:0; grid-template-columns:1fr; }.dsh-study-skill-list { max-height:260px; border-right:0; border-bottom:1px solid var(--dsw-alias-border-l2,#dfe4eb); } }
.dsh-study-management-field { display:grid; gap:5px; margin:10px 0; font-size:12px; font-weight:650; }.dsh-study-management input,.dsh-study-management textarea,.dsh-study-management select { width:100%; border:1px solid var(--dsw-alias-border-l2,#d0d5dd); border-radius:7px; padding:8px; background:var(--dsw-alias-bg-base,#fff); color:inherit; font:inherit; font-weight:400; }.dsh-study-management textarea { min-height:130px; resize:vertical; font-family:var(--dsw-alias-font-family-mono,ui-monospace,monospace); }
.dsh-study-management-permission { display:grid; grid-template-columns:20px 1fr; gap:9px; padding:11px 0; border-bottom:1px solid var(--dsw-alias-border-l2,#eef2f6); }.dsh-study-management-permission:last-child { border-bottom:0; }.dsh-study-management-permission small { display:block; margin-top:3px; color:var(--dsw-alias-label-secondary,#667085); }
.dsh-study-management-alert { margin:12px 0; padding:10px 12px; border-radius:8px; background:#fff5f5; color:#b42318; font-size:13px; }.dsh-study-management-note { padding:10px 12px; border-left:3px solid #d0a300; background:#fff9df; color:#594500; font-size:13px; }.dsh-study-management-dialog { margin-top:12px; }.dsh-study-management-empty { padding:28px; text-align:center; color:var(--dsw-alias-label-secondary,#667085); }
`
