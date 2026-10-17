/* ════════════════════════════════════════════════════════════════════════════
   BEAura — Aura Points (employee recognition) for every portal.

   Data: aura_point_transactions / best_employee_selections (20261027_aura_points.sql).
   Reads go straight to the tables (read-only for the browser). EVERY write — award, Best
   Employee selection, reversal — goes through the `aura` edge function, which re-resolves
   the caller from the ERP sign-in and enforces the hierarchy. Totals are always the SUM of
   active transactions; nothing here ever writes a total.

   BEAura.mountProfile(el, employee, {self})   stat (lifetime · this month) + history
   BEAura.dashboard(el, {mode:'hr'|'manager'}) overview · ranking · Best Employee
   BEAura.give()                               "Give Aura Points" dialog (permission-scoped)
   BEAura.watch()                              live "+50 Aura Points" toast for the signed-in employee
   Aura is recognition only — never read by payroll, leave, attendance or performance code.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BEAura) return;
  var DIV = { education: 'Academics', production: 'Media / Production', sales: 'Sales', hr: 'HR', accounts: 'Accounts', management: 'Management', other: 'Administration' };
  var REASONS = ['Excellent Performance', 'Strong Teamwork', 'Outstanding Student Feedback', 'Completed Urgent Work', 'Consistent Performance', 'Outstanding Creative Work', 'Went Beyond Responsibility'];
  var S = { client: null, emps: null, empAt: 0, scope: null, scopeAt: 0, me: null, mine: null, tx: null, txAt: 0 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function db() {
    try { if (typeof dbInstance !== 'undefined' && dbInstance) return dbInstance; } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return sb; } catch (_) {}
    if (!S.client && window.supabase && B().url) S.client = window.supabase.createClient(B().url, B().anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return S.client;
  }
  function toast(kind, msg) { if (typeof window.showToast === 'function') { try { return window.showToast(kind, msg); } catch (_) {} } pop(msg, kind === 'error'); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function istToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  function istDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ts)); }
  function fDay(iso, year) { var d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', year ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return (w[0] || '').toUpperCase(); }).join('') || '?'; }
  function uuid() { try { return crypto.randomUUID(); } catch (_) { return 'k' + Date.now() + Math.random().toString(36).slice(2); } }
  var MARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.4 5.6L20 9.3l-4.3 3.9 1.2 5.8L12 16.1 7.1 19l1.2-5.8L4 9.3l5.6-.7z"/></svg>';

  function css() {
    if (document.getElementById('aura-css')) return;
    var s = document.createElement('style'); s.id = 'aura-css';
    s.textContent = [
      '.au{--au:#ff8a3d;color:#e6e9f5;font-family:inherit}',
      '.au-stat{display:flex;align-items:center;gap:16px;flex-wrap:wrap}',
      '.au-num{display:flex;flex-direction:column;gap:2px;min-width:0;cursor:pointer;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:0}',
      '.au-k{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8b93b8}.au-k svg{color:var(--au)}',
      '.au-v{font-size:30px;font-weight:800;color:#fff;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums}',
      '.au-sub{font-size:12px;color:#8b93b8;font-variant-numeric:tabular-nums}.au-sub b{color:#34d399;font-weight:700}',
      '.au-give{margin-left:auto;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,138,61,.4);background:rgba(255,107,6,.08);color:#ffb37a;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.au-give:hover{background:rgba(255,107,6,.14);color:#fff}',
      '.au-hist[hidden]{display:none}.au-hist{margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:6px;display:flex;flex-direction:column}',
      '.au-tx{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:2px 12px;align-items:start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04)}',
      '.au-tx:last-child{border-bottom:0}.au-pts{font-weight:800;color:#fff;font-size:14px;font-variant-numeric:tabular-nums}.au-pts.neg{color:#f87171}',
      '.au-why{color:#e6e9f5;font-size:13px;font-weight:600;overflow-wrap:anywhere}.au-by{grid-column:2;color:#8b93b8;font-size:11.5px}.au-note{grid-column:2;color:#a5adcf;font-size:12px;font-style:italic}',
      '.au-when{color:#6b74a0;font-size:11.5px;white-space:nowrap}.au-tx.rev{opacity:.5}.au-tx.rev .au-why{text-decoration:line-through}',
      '.au-empty{padding:18px 0;color:#6b74a0;font-size:12.5px}',
      '.au-more{border:0;background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:8px 0;text-align:left}.au-more:hover{color:#fff}',
      /* modal */
      '.au-ov{position:fixed;inset:0;z-index:9300;display:grid;place-items:center;padding:16px;background:rgba(3,5,9,.66);backdrop-filter:blur(4px)}',
      '.au-dlg{box-sizing:border-box;width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:18px;background:#0e1222;border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px -20px rgba(0,0,0,.85);padding:20px 20px 18px;display:flex;flex-direction:column;gap:14px}',
      '.au-dlg h3{margin:0;font-size:17px;color:#fff;font-weight:800}.au-dlg .sub{margin:-8px 0 0;font-size:12px;color:#8b93b8}',
      '.au-f{display:flex;flex-direction:column;gap:6px}.au-f>span{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#6b74a0}.au-f>span b{color:#f87171}',
      '.au-in,.au .au-in{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08)!important;background:rgba(255,255,255,.03)!important;color:#fff;font:inherit;font-size:13px!important;outline:none}',
      'textarea.au-in{height:auto;min-height:60px;padding:9px 12px;resize:vertical;line-height:1.45}.au-in:focus{border-color:rgba(255,107,6,.55)!important}',
      '.au-pick{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:2px;margin-top:4px}',
      '.au-opt{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px;border:0;background:none;color:#e6e9f5;font:inherit;font-size:13px;cursor:pointer;text-align:left;width:100%}',
      '.au-opt:hover,.au-opt.on{background:rgba(255,107,6,.1)}.au-opt small{display:block;color:#6b74a0;font-size:11px}',
      '.au-av{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2a3150,#1a1f35)}',
      '.au-chips{display:flex;gap:8px;flex-wrap:wrap}.au-chip{min-width:62px;height:40px;padding:0 14px;border-radius:11px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#c7cbe0;font:inherit;font-size:14px;font-weight:800;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.au-chip.on{color:#fff;border-color:rgba(255,107,6,.6);background:rgba(255,107,6,.14)}',
      '.au-sugg{display:flex;flex-wrap:wrap;gap:6px}.au-sugg button{border:1px solid rgba(255,255,255,.08);background:none;color:#8b93b8;border-radius:999px;padding:4px 10px;font:inherit;font-size:11.5px;cursor:pointer}.au-sugg button:hover{color:#fff;border-color:rgba(255,255,255,.2)}',
      '.au-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.au-btn{height:40px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e6e9f5;font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
      '.au-btn.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552)}.au-btn:disabled{opacity:.6;cursor:progress}',
      '.au-confirm{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.03)}.au-confirm span{color:#6b74a0}.au-confirm b{color:#fff;font-weight:600;overflow-wrap:anywhere}',
      '.au-err{color:#f87171;font-size:12.5px}',
      '.au-pop{position:fixed;left:50%;top:20px;z-index:9400;transform:translate(-50%,-12px);opacity:0;transition:all .22s ease;display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;background:#11182a;border:1px solid rgba(255,138,61,.35);box-shadow:0 20px 50px -14px rgba(0,0,0,.8);color:#e6e9f5;max-width:calc(100vw - 24px)}',
      '.au-pop.on{transform:translate(-50%,0);opacity:1}.au-pop b{display:block;color:#fff;font-size:14.5px;font-variant-numeric:tabular-nums}.au-pop span{display:block;color:#a5adcf;font-size:12px}.au-pop svg{color:#ff8a3d;flex-shrink:0}',
      /* dashboard */
      '.aud{display:flex;flex-direction:column;gap:16px}',
      '.aud-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}.aud-top h2{margin:0;font-size:22px;font-weight:800;color:#fff}.aud-top p{margin:4px 0 0;color:#8b93b8;font-size:12.5px}',
      '.aud-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.aud-bar .au-in{width:auto;min-width:0;height:36px}.aud-bar .q{flex:1 1 200px}',
      '.aud-seg{display:inline-flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}',
      '.aud-seg button{border:0;background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:700;height:30px;padding:0 12px;border-radius:7px;cursor:pointer;white-space:nowrap}.aud-seg button.on{background:rgba(255,255,255,.08);color:#fff}',
      '.aud-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(255,255,255,.07)}.aud-tabs button{border:0;background:none;color:#8b93b8;font:inherit;font-size:13px;font-weight:700;padding:10px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.aud-tabs button.on{color:#fff;border-bottom-color:#ff6b06}',
      '.aud-tbl{width:100%;border-collapse:collapse;font-size:13px}.aud-tbl th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6b74a0;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap;cursor:pointer;user-select:none}',
      '.aud-tbl td{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.04);color:#c7cbe0;vertical-align:middle}.aud-tbl td.n{font-variant-numeric:tabular-nums;color:#fff;font-weight:700}.aud-tbl tr:hover td{background:rgba(255,255,255,.015)}',
      '.aud-who{display:flex;align-items:center;gap:10px;min-width:0}.aud-who b{color:#fff;font-weight:600}.aud-who small{display:block;color:#6b74a0;font-size:11px}',
      '.aud-rank{display:flex;flex-direction:column}.aud-r{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid rgba(255,255,255,.05)}',
      '.aud-r .pos{font-size:18px;font-weight:800;color:#6b74a0;font-variant-numeric:tabular-nums;text-align:center}.aud-r.top .pos{color:#ffb37a}',
      '.aud-r .pts{font-size:18px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;text-align:right}.aud-r .pts small{display:block;font-size:10.5px;color:#6b74a0;font-weight:600}',
      '.aud-tie{font-size:10px;font-weight:800;letter-spacing:.06em;color:#fbbf24;border:1px solid rgba(251,191,36,.4);border-radius:999px;padding:1px 7px;margin-left:6px}',
      '.aud-sel{height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,138,61,.4);background:rgba(255,107,6,.08);color:#ffb37a;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.aud-best{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:linear-gradient(120deg,rgba(255,107,6,.08),rgba(255,255,255,.02));border:1px solid rgba(255,138,61,.25)}',
      '.aud-best .k{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ffb37a}.aud-best b{display:block;color:#fff;font-size:16px}.aud-best span{color:#8b93b8;font-size:12px}',
      '.aud-wrap{overflow-x:auto;border:1px solid rgba(255,255,255,.06);border-radius:14px}',
      '@media(max-width:700px){.aud-tbl thead{display:none}.aud-tbl,.aud-tbl tbody,.aud-tbl tr,.aud-tbl td{display:block;width:100%}.aud-tbl tr{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.05)}.aud-tbl td{padding:3px 0;border:0}.aud-tbl td[data-l]::before{content:attr(data-l) "  ";color:#6b74a0;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.aud-tbl td{text-align:left!important}.aud-tbl td.n{display:inline-block;width:auto;margin-right:16px}.aud-wrap{border:0}}',
      /* give flow */
      '.au-av{position:relative;overflow:hidden}.au-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '.au-opt .au-oa{margin-left:auto;font-size:11.5px;font-weight:700;color:#ffb37a;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.au-opt > span:nth-child(2){min-width:0;flex:1}.au-opt > span:nth-child(2) > span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.au-dchips{display:flex;gap:6px;flex-wrap:wrap}.au-dchips button{height:28px;padding:0 11px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:none;color:#8b93b8;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}.au-dchips button.on{color:#fff;border-color:rgba(255,107,6,.5);background:rgba(255,107,6,.1)}',
      '.au-chip{flex:1 1 0;min-width:0}.au-confirm .tot{color:#34d399}',
      '.au-chip{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;height:52px}.au-chip small{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b74a0}.au-chip.on small{color:#ffb37a}',
      '.au-skel{display:flex;flex-direction:column;gap:8px;padding:6px 4px}.au-skel i{display:block;height:34px;border-radius:9px;background:linear-gradient(90deg,rgba(255,255,255,.03),rgba(255,255,255,.07),rgba(255,255,255,.03));background-size:200% 100%;animation:auSk 1.1s linear infinite}@keyframes auSk{to{background-position:-200% 0}}',
      '.au-sugg button.on{color:#fff;border-color:rgba(255,107,6,.5);background:rgba(255,107,6,.1)}',
      '.au-gh{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.au-dlg .au-gh .sub{margin:4px 0 0}.au-recent{display:flex;flex-direction:column;min-height:0}.au-recent .au-rh{margin-top:4px}.au-recent .au-hist{margin-top:2px;border-top:0;padding-top:0}.au-recent .au-tx{grid-template-columns:44px minmax(0,1fr) auto;padding:8px 0}.au-gh .au-x{position:static;flex-shrink:0}',
      '.au-gv{display:flex;flex-direction:column;gap:14px}.au-gv-r{display:flex;flex-direction:column;gap:14px;min-width:0}.au-gv-l{min-width:0}',
      '.au-sel{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;background:radial-gradient(120% 120% at 0% 0%,rgba(255,138,61,.1),rgba(255,255,255,.02) 60%);border:1px solid rgba(255,138,61,.22)}',
      '.au-sel-hd{display:flex;align-items:center;gap:12px;min-width:0}.au-sel-who{min-width:0}.au-av.lg{width:44px;height:44px;font-size:14px}.au-sel-who b{display:block;color:#fff;font-size:15px}.au-sel-who small{color:#8b93b8;font-size:12px}',
      '.au-sel-st{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.au-sel-st div{display:flex;flex-direction:column;gap:2px;padding:9px 10px;border-radius:10px;background:rgba(0,0,0,.18)}.au-sel-st span{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#6b74a0}.au-sel-st b{color:#fff;font-size:17px;font-variant-numeric:tabular-nums}.au-after b{color:#34d399!important}',
      '.au-sel .au-more{padding:0;align-self:flex-start}',
      '@media(max-width:860px){.au-recent{display:none}}',
      '@media(min-width:861px){.au-dlg.au-wide{width:min(900px,calc(100vw - 48px));padding:24px 26px 22px}.au-gv{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);gap:26px;align-items:stretch}.au-gv-l{padding-right:26px;border-right:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column}.au-gv-l .au-pick{flex:1;max-height:420px;min-height:260px}.au-sel{flex:0 0 auto}.au-sel .au-av.lg{width:56px;height:56px;font-size:17px}.au-sel-st{grid-template-columns:1fr 1fr}.au-after{grid-column:1/-1}.au-after b{font-size:22px!important}}',
      '.au-ok{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:26px 8px 18px}',
      '.au-ok .halo{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;color:#ff8a3d;position:relative;margin-bottom:6px}',
      '.au-ok .halo::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(rgba(255,138,61,.95),rgba(249,24,47,.5),rgba(255,180,120,.6),rgba(255,138,61,.95));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.6px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.6px));animation:auOkRing .9s cubic-bezier(.2,.8,.2,1) both}',
      '.au-ok .halo svg{width:26px;height:26px;animation:auOkIn .5s .25s both}.au-ok b{font-size:26px;color:#fff;font-weight:800;font-variant-numeric:tabular-nums;animation:auOkIn .5s .3s both}.au-ok span{color:#a5adcf;font-size:13px;animation:auOkIn .5s .4s both}',
      '@keyframes auOkRing{from{transform:scale(.6) rotate(-90deg);opacity:0}to{transform:none;opacity:1}}@keyframes auOkIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.au-ok *,.au-ok .halo::before{animation:none!important}}',
      /* quick action + row actions */
      '[data-au-quick]{display:none}',
      '.au-qbtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,138,61,.35);background:rgba(255,107,6,.06);color:#ffb37a;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap}.au-qbtn:hover{color:#fff;background:rgba(255,107,6,.14)}',
      '.au-hbtn{height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:none;color:#8b93b8;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap}.au-hbtn:hover{color:#fff}',
      '.aud-act{display:flex;gap:6px;justify-content:flex-end}',
      '.aud-r.wide{grid-template-columns:44px minmax(0,1fr) auto auto auto}',
      /* dashboard as its own page-level panel (heads / operations managers) */
      '.au-sheet{position:fixed;inset:0;z-index:9200;background:rgba(3,5,9,.66);backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:flex-start;padding:28px 16px;overflow:auto}',
      '.au-sheet > .au-pane{box-sizing:border-box;width:min(1080px,100%);background:#0b0f1c;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:22px;position:relative;box-shadow:0 30px 80px -20px rgba(0,0,0,.85)}',
      '.au-x{position:absolute;top:14px;right:14px;width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#a5adcf;font-size:18px;line-height:1;cursor:pointer}.au-x:hover{color:#fff}',
      '.au-nav-aura svg{color:#ff8a3d}',
      '@media(max-width:560px){.au-ov{place-items:end stretch;grid-template-columns:minmax(0,1fr);padding:0}.au-ov > .au-dlg{width:100%;box-sizing:border-box;max-height:92vh;border-radius:20px 20px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom));animation:auUp .22s ease-out}.au-sheet{padding:0}.au-sheet > .au-pane{border-radius:0;min-height:100%;padding:16px}.aud-r.wide{grid-template-columns:32px minmax(0,1fr) auto}.aud-r.wide .aud-act{grid-column:2/-1;justify-content:flex-start}}',
      '@keyframes auUp{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}',
      /* profile: stats row + recent */
      '.au-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;flex:1 1 360px;min-width:0}',
      '.au-st{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);min-width:0}',
      '.au-st .au-v{font-size:24px}.au-st:first-child{background:radial-gradient(120% 140% at 0% 0%,rgba(255,138,61,.12),rgba(255,255,255,.02) 60%);border-color:rgba(255,138,61,.22)}',
      '.au-st .au-v.pos{color:#34d399}',
      '.au-rh{display:flex;align-items:center;justify-content:space-between;margin-top:16px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8b93b8}',
      /* header ring around the avatar (decorative identity; never a progress meter) */
      '.au-avw{position:relative;display:inline-flex;flex-shrink:0;border-radius:50%}',
      '.au-ring{position:absolute;inset:-3px;border-radius:50%;pointer-events:none;background:conic-gradient(from var(--au-a,0deg),rgba(255,138,61,.95),rgba(249,24,47,.55) 28%,rgba(255,255,255,.08) 52%,rgba(255,180,120,.6) 78%,rgba(255,138,61,.95));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 1.6px),#000 calc(100% - 1.4px));mask:radial-gradient(farthest-side,transparent calc(100% - 1.6px),#000 calc(100% - 1.4px));opacity:.85;animation:auSpin 14s linear infinite}',
      '.au-ring::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:0 0 10px 1px rgba(255,138,61,.0);transition:box-shadow .6s}',
      '.au-avw.pulse .au-ring{opacity:1;animation:auSpin 14s linear infinite,auPulse 1.4s ease-out 3}',
      '.au-avw.pulse .au-ring::after{box-shadow:0 0 14px 2px rgba(255,138,61,.45)}',
      '@property --au-a{syntax:"<angle>";inherits:false;initial-value:0deg}',
      '@keyframes auSpin{to{--au-a:360deg}}',
      '@keyframes auPulse{0%{transform:scale(1)}40%{transform:scale(1.12)}100%{transform:scale(1)}}',
      '@media (prefers-reduced-motion:reduce){.au-ring,.au-avw.pulse .au-ring{animation:none}}',
      '.au-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 0 0 10px!important;border-left:1px solid rgba(255,255,255,.08);font-size:11px;font-weight:700;color:#ffb37a;font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 2px;cursor:pointer}.au-tag svg{width:11px;height:11px}',
      '.au-tag:hover{color:#fff}',
      '@media(max-width:1100px){.au-tag{display:none}}',
      /* hover popover (desktop) */
      '.au-hc{position:fixed;z-index:9250;width:248px;padding:14px;border-radius:14px;background:#0e1222;border:1px solid rgba(255,138,61,.22);box-shadow:0 24px 60px -18px rgba(0,0,0,.85);opacity:0;transform:translateY(-4px);transition:opacity .15s,transform .15s;pointer-events:none}',
      '.au-hc.on{opacity:1;transform:none;pointer-events:auto}',
      '.au-hc .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0 12px}.au-hc .au-v{font-size:26px}.au-hc .au-sm{font-size:16px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums}.au-hc .au-sm.pos{color:#34d399}',
      '.au-hc .au-link{width:100%;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#e6e9f5;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}.au-hc .au-link:hover{border-color:rgba(255,138,61,.4);color:#fff}',
      /* account-menu row */
      '.am-item.au-mrow{display:flex;align-items:center;gap:10px}.au-mrow .au-mv{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15}.au-mrow .au-mv b{color:#fff;font-size:13px;font-variant-numeric:tabular-nums}.au-mrow .au-mv small{color:#34d399;font-size:10.5px;font-weight:700}.au-mrow > svg{color:#ff8a3d}',
      /* My Aura panel */
      '.au-mine .au-stats{margin-top:2px;flex:none}.au-mine .au-hist{margin-top:4px;border-top:0;padding-top:0}',
      '@media(max-width:560px){.au-stats{grid-template-columns:1fr 1fr}.au-st:first-child{grid-column:1/-1}.au-st .au-v{font-size:22px}}',
      '@media(max-width:560px){.au-v{font-size:26px}.au-give{margin-left:0;width:100%;justify-content:center}.aud-r{grid-template-columns:32px minmax(0,1fr) auto;row-gap:8px}.aud-r .aud-sel{grid-column:2/-1;justify-self:start}.aud-seg{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:3px}.aud-seg button{width:100%}.aud-bar .au-in{flex:1 1 140px}.au-acts .au-btn{flex:1}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── server calls (the only write path) ───────────────────────────────────
  async function api(action, body) {
    var tk = B().ensure ? await B().ensure() : (B().token ? B().token() : null);
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/aura', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !(body && body._retry) && B().clear && B().ensure && j.code === 'SESSION_EXPIRED') {
      // Token rejected by the server (expired / rotated): drop it, re-issue once, retry.
      try { B().clear(B().currentEmail()); } catch (_) {}
      if (await B().ensure()) return api(action, Object.assign({}, body || {}, { _retry: true }));
    }
    if (!r.ok) throw new Error(j.error || 'Aura Points is unavailable right now.');
    return j;
  }
  // Scope = who I may reward + their current Aura (server-computed, one call). Cached in memory
  // and per tab (sessionStorage, per signed-in email) so the Give dialog can open instantly;
  // every award is still re-checked on the server, the cache only drives the UI.
  function scopeKey() { var e = B().currentEmail ? String(B().currentEmail() || '').toLowerCase() : ''; return e ? 'be_aura_scope:' + e : ''; }
  function saveScope() { var k = scopeKey(); if (!k || !S.scope) return; try { sessionStorage.setItem(k, JSON.stringify({ at: S.scopeAt, data: S.scope })); } catch (_) {} }
  function scopeCached() {
    if (S.scope) return S.scope;
    var k = scopeKey(); if (!k) return null;
    try { var c = JSON.parse(sessionStorage.getItem(k) || 'null'); if (c && c.data && Date.now() - c.at < 600000) { S.scope = c.data; S.scopeAt = c.at; return S.scope; } } catch (_) {}
    return null;
  }
  async function scope(force) {
    if (!force && (S.scope || scopeCached()) && Date.now() - S.scopeAt < 60000) return S.scope;
    if (S.scopeP) return S.scopeP;   // one request in flight, shared by every caller
    S.scopeP = api('scope').then(function (x) { S.scope = x; S.scopeAt = Date.now(); saveScope(); return x; })
      .finally(function () { S.scopeP = null; });
    return S.scopeP;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  async function employees() {
    if (S.emps && Date.now() - S.empAt < 120000) return S.emps;
    var r = await db().from('hr_employees').select('id,full_name,division,designation,employment_status,account_type,portal_email,photo_url');
    S.emps = (r.data || []).filter(function (e) { return e.account_type !== 'system' && e.full_name; }); S.empAt = Date.now();
    return S.emps;
  }
  async function txFor(empId) {
    var r = await db().from('aura_point_transactions').select('*').eq('recipient_employee_id', empId).order('created_at', { ascending: false }).limit(200);
    if (r.error) throw r.error;
    return r.data || [];
  }
  async function allTx() {
    var out = [], from = 0;
    for (;;) {
      var r = await db().from('aura_point_transactions').select('id,recipient_employee_id,points,status,created_at,reason').eq('status', 'active').range(from, from + 999);
      if (r.error) throw r.error;
      out = out.concat(r.data || []); if (!r.data || r.data.length < 1000) break; from += 1000;
    }
    return out;
  }
  async function totals(force) {   // lifetime Aura per employee (active rows), cached briefly
    if (!force && S.tx && Date.now() - S.txAt < 20000) return S.tx;
    var rows = await allTx(), m = monthRange(0), out = {};
    rows.forEach(function (t) { var x = out[t.recipient_employee_id] || (out[t.recipient_employee_id] = { life: 0, month: 0 }); x.life += Number(t.points || 0); var d = istDay(t.created_at); if (d >= m.from && d <= m.to) x.month += Number(t.points || 0); });
    S.tx = out; S.txAt = Date.now(); return out;
  }
  function photoOf(id) {
    var e = (S.emps || []).filter(function (x) { return x.id === id; })[0]; if (!e || !e.photo_url) return '';
    var u = e.photo_url; try { if (typeof hrConvertDriveUrl === 'function') u = hrConvertDriveUrl(u); } catch (_) {}
    return /^(https?:|data:image)/.test(u) ? u : '';
  }
  function av(id, name, url) {
    var u = url ? (function () { try { return typeof hrConvertDriveUrl === 'function' ? hrConvertDriveUrl(url) : url; } catch (_) { return url; } })() : photoOf(id);
    if (u && !/^(https?:|data:image)/.test(u)) u = '';
    return '<span class="au-av">' + (u ? '<img src="' + esc(u) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + esc(initials(name)) + '</span>';
  }
  function deptName(d) { return DIV[d] || d || ''; }
  function sum(rows, from, to) {
    return rows.filter(function (t) { if (t.status !== 'active') return false; var d = istDay(t.created_at); return (!from || d >= from) && (!to || d <= to); })
      .reduce(function (s, t) { return s + Number(t.points || 0); }, 0);
  }
  function monthRange(offset) {
    var t = istToday(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1 + (offset || 0);
    var a = new Date(Date.UTC(y, m, 1)), b = new Date(Date.UTC(y, m + 1, 0));
    return { from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10), label: a.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }

  function pop(msg, bad, sub) {
    css();
    var el = document.createElement('div'); el.className = 'au-pop'; el.setAttribute('role', 'status');
    el.innerHTML = MARK + '<div><b>' + esc(msg) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>';
    if (bad) el.style.borderColor = 'rgba(248,113,113,.45)';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 260); }, 3600);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Profile: Aura stat near the top + recognition history
  // ════════════════════════════════════════════════════════════════════════
  function statsHTML(life, month, n, rank) {
    return '<div class="au-stats">'
      + '<div class="au-st"><span class="au-k">' + MARK + 'Aura Points</span><span class="au-v">' + life.toLocaleString('en-IN') + '</span>' + (rank ? '<span class="au-sub">#' + rank + ' this month</span>' : '') + '</div>'
      + '<div class="au-st"><span class="au-k">This Month</span><span class="au-v' + (month > 0 ? ' pos' : '') + '">' + (month > 0 ? '+' : '') + month.toLocaleString('en-IN') + '</span></div>'
      + '<div class="au-st"><span class="au-k">Recognition Received</span><span class="au-v">' + n + '</span></div></div>';
  }
  async function mountProfile(el, emp, opts) {
    if (!el || !emp) return; css(); opts = opts || {};
    el.classList.add('au');
    var rows;
    try { rows = await txFor(emp.id); }
    catch (e) { el.innerHTML = /aura_point|relation|schema cache/i.test(e.message || '') ? '' : '<div class="au-empty">Aura Points could not load.</div>'; return; }
    var life = sum(rows), m = monthRange(0), month = sum(rows, m.from, m.to), active = rows.filter(function (t) { return t.status === 'active'; });
    var canGive = false, giveFor = null;
    try {
      var sc = await scope();
      if (opts.self) canGive = !!sc.can_award;
      else if ((sc.eligible || []).some(function (x) { return x.id === emp.id; })) { canGive = true; giveFor = emp.id; }
    } catch (_) {}
    var rest = rows.length > 3;
    el.innerHTML = '<div class="au-stat">' + statsHTML(life, month, active.length, 0)
      + (canGive ? '<button type="button" class="au-give" data-au-give>' + MARK + 'Give Aura Points</button>' : '') + '</div>'
      + '<div class="au-rh"><span>Recent Aura</span>' + (rest ? '<button type="button" class="au-more" data-au-toggle aria-expanded="false" style="padding:0">View all ' + rows.length + '</button>' : '') + '</div>'
      + '<div class="au-hist" style="margin-top:6px;border-top:0;padding-top:0" data-au-top>' + history(rows.slice(0, 3), { self: opts.self, limit: 3 }) + '</div>'
      + (rest ? '<div class="au-hist" style="margin-top:0;border-top:0;padding-top:0" data-au-hist hidden>' + history(rows.slice(3), { self: opts.self, limit: 60 }) + '</div>' : '');
    var tg = el.querySelector('[data-au-toggle]');
    if (tg) tg.onclick = function () { var h = el.querySelector('[data-au-hist]'); h.hidden = !h.hidden; this.setAttribute('aria-expanded', String(!h.hidden)); this.textContent = h.hidden ? 'View all ' + rows.length : 'Show less'; };
    var g = el.querySelector('[data-au-give]'); if (g) g.onclick = function () { give({ employeeId: giveFor, onDone: function () { mountProfile(el, emp, opts); } }); };
    if (opts.openHistory && tg) tg.click();
    if (!el._auHook) { el._auHook = true; document.addEventListener('be-aura-changed', function (ev) { var id = ev.detail && ev.detail.employeeId; if (el.isConnected && (!id || id === emp.id)) mountProfile(el, emp, opts); }); }
  }
  function history(rows, opts) {
    if (!rows.length) return '<div class="au-empty">' + (opts.self ? 'No Aura Points yet — recognitions from your Head or Manager will appear here.' : 'No Aura Points yet.') + '</div>';
    var show = rows.slice(0, opts.limit || 12);
    return show.map(function (t) {
      var rev = t.status === 'reversed', neg = Number(t.points) < 0;
      return '<div class="au-tx' + (rev ? ' rev' : '') + '"><span class="au-pts' + (neg ? ' neg' : '') + '">' + (neg ? '' : '+') + t.points + '</span><span class="au-why">' + esc(t.reason) + (t.kind === 'adjustment' ? ' <span style="color:#6b74a0;font-weight:500">(adjustment)</span>' : '') + '</span><span class="au-when">' + esc(fDay(istDay(t.created_at))) + '</span>'
        + '<span class="au-by">Awarded by ' + esc(t.awarded_by_name || '—') + (rev ? ' · reversed' + (t.reversal_reason ? ': ' + esc(t.reversal_reason) : '') : '') + '</span>'
        + (t.note ? '<span class="au-note">“' + esc(t.note) + '”</span>' : '') + '</div>';
    }).join('') + (rows.length > show.length ? '<div class="au-empty">+ ' + (rows.length - show.length) + ' earlier recognitions</div>' : '');
  }

  // ════════════════════════════════════════════════════════════════════════
  // Give Aura Points (employee list + point options come from the server scope)
  // ════════════════════════════════════════════════════════════════════════
  async function give(opts) {
    css(); opts = opts || {};
    // Opens at once: cached scope (prefetched after sign-in) renders immediately, a fresh copy is
    // fetched in the background; without a cache the list shows a small skeleton meanwhile.
    var sc = null, tot = {}, depts = [], pre = null;
    var st = { emp: null, pts: null, reason: '', note: '', key: uuid(), busy: false, q: '', dept: '' };
    function setSc(x) {
      sc = x; tot = {}; depts = [];
      (x.eligible || []).forEach(function (e) { tot[e.id] = { life: e.aura || 0, month: e.month || 0 }; if (e.division && depts.indexOf(e.division) < 0) depts.push(e.division); });
      if (opts.employeeId) { pre = x.eligible.filter(function (e) { return e.id === opts.employeeId; })[0] || null; if (!st.emp) st.emp = pre; }
      else if (st.emp) st.emp = x.eligible.filter(function (e) { return e.id === st.emp.id; })[0] || null;
    }
    function allowed() {
      if (!sc.can_award) { close(); toast('error', sc.tier === 'employee' ? 'Your role can\'t give Aura Points.' : 'There is no one in your team you can give Aura Points to.'); return false; }
      if (opts.employeeId && !pre) { close(); toast('error', 'You can\'t give Aura Points to this employee.'); return false; }
      return true;
    }
    var ov = document.createElement('div'); ov.className = 'au-ov au';
    ov.innerHTML = '<div class="au-dlg" role="dialog" aria-modal="true" aria-label="Give Aura Points"></div>';
    document.body.appendChild(ov);
    var dlg = ov.querySelector('.au-dlg');
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape' && !st.busy) close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', function (e) { if (e.target === ov && !st.busy) close(); });
    var life = function (id) { return (tot[id] && tot[id].life) || 0; };
    function optHTML(x, on, change) {
      return '<button type="button" class="au-opt' + (on ? ' on' : '') + '" ' + (change ? 'data-change' : 'data-emp="' + x.id + '"') + '>' + av(x.id, x.name, x.photo_url)
        + '<span><span>' + esc(x.name) + '</span><small>' + esc([x.designation, x.department].filter(Boolean).join(' · ')) + (change ? ' · change' : '') + '</small></span>'
        + '<span class="au-oa">Aura ' + life(x.id).toLocaleString('en-IN') + '</span></button>';
    }
    function list() {
      if (!sc) return '<div class="au-skel"><i></i><i></i><i></i><i></i></div>';
      var q = st.q.toLowerCase();
      var l = sc.eligible.filter(function (x) { return (!st.dept || x.division === st.dept) && (!q || (x.name + ' ' + x.department + ' ' + x.designation).toLowerCase().indexOf(q) > -1); });
      return l.length ? l.slice(0, 80).map(function (x) { return optHTML(x, st.emp && st.emp.id === x.id); }).join('') : '<div class="au-empty">No one matches.</div>';
    }
    function selCard() {
      var x = st.emp, t = tot[x.id] || { life: 0, month: 0 };
      return '<div class="au-sel"><div class="au-sel-hd">' + av(x.id, x.name, x.photo_url).replace('class="au-av"', 'class="au-av lg"')
        + '<div class="au-sel-who"><b>' + esc(x.name) + '</b><small>' + esc([x.designation, x.department].filter(Boolean).join(' · ')) + '</small></div></div>'
        + '<div class="au-sel-st"><div><span>Current Aura</span><b>' + t.life.toLocaleString('en-IN') + '</b></div><div><span>This month</span><b>' + (t.month ? '+' + t.month : '0') + '</b></div>'
        + '<div class="au-after"><span>After award</span><b data-after>' + (st.pts ? (t.life + st.pts).toLocaleString('en-IN') : '—') + '</b></div></div>'
        + (pre ? '' : '<button type="button" class="au-more" data-change>Change employee</button>') + '</div>'
        + '<div class="au-recent" data-recent></div>';
    }
    function loadRecent() {
      var box = dlg.querySelector('[data-recent]'); if (!box || !st.emp) return;
      var id = st.emp.id;
      txFor(id).then(function (rows) {
        if (!box.isConnected || !st.emp || st.emp.id !== id) return;
        box.innerHTML = '<div class="au-rh"><span>Recent Aura</span></div><div class="au-hist">' + history(rows.slice(0, 4), { limit: 4 }) + '</div>';
      }).catch(function () {});
    }
    function form() {
      var who = !sc ? 'Loading your team…' : (sc.scope === 'organisation' ? 'All departments' : sc.scope) + ' · up to ' + Math.max.apply(null, sc.points) + ' points per award';
      var org = sc && sc.scope === 'organisation';
      dlg.classList.add('au-wide');
      dlg.innerHTML = '<div class="au-gh"><div><h3>Give Aura Points</h3><p class="sub">' + esc(who) + '</p></div><button type="button" class="au-x" data-cancel aria-label="Close">×</button></div>'
        + '<div class="au-gv"><div class="au-gv-l au-f"><span>Employee <b>*</b></span>' + (st.emp ? selCard()
          : '<input class="au-in" data-q placeholder="' + (org ? 'Search by name, department, designation…' : 'Search employee…') + '" autocomplete="off" value="' + esc(st.q) + '">'
            + (depts.length > 1 ? '<div class="au-dchips"><button type="button" data-dept="" class="' + (!st.dept ? 'on' : '') + '">All departments</button>' + depts.map(function (d) { return '<button type="button" data-dept="' + esc(d) + '" class="' + (st.dept === d ? 'on' : '') + '">' + esc(deptName(d)) + '</button>'; }).join('') + '</div>' : '')
            + '<div class="au-pick" data-list>' + list() + '</div>') + '</div>'
        + '<div class="au-gv-r">'
        + '<div class="au-f"><span>Points <b>*</b></span><div class="au-chips">' + (sc ? sc.points : [10, 20, 50]).map(function (p) { return '<button type="button" class="au-chip' + (st.pts === p ? ' on' : '') + '" data-pts="' + p + '"' + (sc ? '' : ' disabled') + ' aria-pressed="' + (st.pts === p) + '">' + p + '<small>points</small></button>'; }).join('') + '</div></div>'
        + '<div class="au-f"><span>Reason <b>*</b></span><input class="au-in" data-reason maxlength="300" placeholder="What is this recognition for?" value="' + esc(st.reason) + '"><div class="au-sugg">' + REASONS.map(function (r) { return '<button type="button" data-sugg="' + esc(r) + '" class="' + (st.reason === r ? 'on' : '') + '">' + esc(r) + '</button>'; }).join('') + '</div></div>'
        + '<div class="au-f"><span>Note (optional)</span><textarea class="au-in" data-note maxlength="600" rows="3" style="height:auto;padding:9px 12px" placeholder="Extra context for the employee">' + esc(st.note) + '</textarea></div>'
        + '<div class="au-err" data-err></div>'
        + '<div class="au-acts"><button type="button" class="au-btn" data-cancel>Cancel</button><button type="button" class="au-btn pri" data-next>Give Aura Points</button></div>'
        + '</div></div>';
      var q = dlg.querySelector('[data-q]');
      if (q) { q.addEventListener('input', function () { st.q = q.value; dlg.querySelector('[data-list]').innerHTML = list(); }); if (!('ontouchstart' in window)) setTimeout(function () { q.focus(); }, 30); }
      dlg.querySelector('[data-reason]').addEventListener('input', function () { st.reason = this.value; dlg.querySelectorAll('[data-sugg]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-sugg') === st.reason); }); });
      dlg.querySelector('[data-note]').addEventListener('input', function () { st.note = this.value; });
      loadRecent();
    }
    function confirmView() {
      dlg.classList.remove('au-wide');
      var cur = life(st.emp.id);
      dlg.innerHTML = '<h3>Give ' + st.pts + ' Aura Points?</h3>'
        + '<div class="au-confirm"><span>Employee</span><b>' + esc(st.emp.name) + '</b><span>Department</span><b>' + esc(st.emp.department || '—') + '</b>'
        + '<span>Current Aura</span><b>' + cur.toLocaleString('en-IN') + '</b><span>Points</span><b>+' + st.pts + '</b>'
        + '<span>Reason</span><b>' + esc(st.reason) + '</b>' + (st.note ? '<span>Note</span><b>' + esc(st.note) + '</b>' : '')
        + '<span>New Total</span><b class="tot">' + (cur + st.pts).toLocaleString('en-IN') + '</b></div>'
        + '<div class="au-err" data-err></div>'
        + '<div class="au-acts"><button type="button" class="au-btn" data-back>Cancel</button><button type="button" class="au-btn pri" data-confirm>Confirm Award</button></div>';
    }
    function done() {
      dlg.classList.remove('au-wide');
      dlg.innerHTML = '<div class="au-ok" role="status"><span class="halo">' + MARK + '</span><b>+' + st.pts + ' Aura Points</b><span>Successfully awarded to ' + esc(st.emp.name) + '</span></div>'
        + '<div class="au-acts"><button type="button" class="au-btn" data-cancel>Done</button></div>';
      setTimeout(function () { if (document.body.contains(ov)) close(); }, 2400);
    }
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || st.busy) return;
      if (b.hasAttribute('data-cancel')) return close();
      if (b.hasAttribute('data-emp')) { st.emp = sc.eligible.filter(function (x) { return x.id === b.getAttribute('data-emp'); })[0]; return form(); }
      if (b.hasAttribute('data-change')) { st.emp = null; return form(); }
      if (b.hasAttribute('data-dept')) { st.dept = b.getAttribute('data-dept'); return form(); }
      if (b.hasAttribute('data-pts')) {
        st.pts = +b.getAttribute('data-pts'); dlg.querySelectorAll('[data-pts]').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
        var af = dlg.querySelector('[data-after]'); if (af && st.emp) af.textContent = (life(st.emp.id) + st.pts).toLocaleString('en-IN'); return;
      }
      if (b.hasAttribute('data-sugg')) { st.reason = b.getAttribute('data-sugg'); dlg.querySelector('[data-reason]').value = st.reason; dlg.querySelectorAll('[data-sugg]').forEach(function (x) { x.classList.toggle('on', x === b); }); return; }
      if (b.hasAttribute('data-back')) return form();
      if (b.hasAttribute('data-next')) {
        st.reason = dlg.querySelector('[data-reason]').value.trim(); st.note = dlg.querySelector('[data-note]').value.trim();
        var err = !st.emp ? 'Choose an employee.' : !st.pts ? 'Choose the points.' : !st.reason ? 'Add a reason.' : '';
        if (err) { dlg.querySelector('[data-err]').textContent = err; return; }
        return confirmView();
      }
      if (b.hasAttribute('data-confirm')) {
        st.busy = true; b.disabled = true; b.textContent = 'Giving…';
        var back = dlg.querySelector('[data-back]'); if (back) back.disabled = true;
        try {
          // Same key for every retry of THIS dialog → the server never records it twice.
          await api('award', { recipient_id: st.emp.id, points: st.pts, reason: st.reason, note: st.note || null, idempotency_key: st.key });
          // Local update first (no list reload), then a silent server sync.
          var me = (sc.eligible || []).filter(function (x) { return x.id === st.emp.id; })[0];
          if (me) { me.aura = (me.aura || 0) + st.pts; me.month = (me.month || 0) + st.pts; tot[me.id] = { life: me.aura, month: me.month }; saveScope(); }
          st.busy = false; S.txAt = 0; done();
          setTimeout(function () { scope(true).then(applyScope).catch(function () {}); }, 1500);
          if (opts.onDone) try { opts.onDone(); } catch (_) {}
          document.dispatchEvent(new CustomEvent('be-aura-changed', { detail: { employeeId: st.emp.id } }));
        } catch (x) { st.busy = false; b.disabled = false; if (back) back.disabled = false; b.textContent = 'Confirm Award'; dlg.querySelector('[data-err]').textContent = x.message; }
      }
    });
    var cached = scopeCached();
    if (cached) { setSc(cached); if (!allowed()) return; }
    form();
    if (!cached || Date.now() - S.scopeAt > 30000) {
      scope(true).then(function (fresh) {
        if (!ov.isConnected) return;
        var first = !sc; setSc(fresh); applyScope(fresh);
        if (!allowed()) return;
        if (first || st.emp) return form();
        var l = dlg.querySelector('[data-list]'); if (l) l.innerHTML = list();   // keep typing / focus intact
      }).catch(function (e) { if (!sc && ov.isConnected) { close(); toast('error', e.message); } });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // HR / Manager dashboard: overview + ranking + Best Employee
  // ════════════════════════════════════════════════════════════════════════
  async function dashboard(el, opts) {
    if (!el) return; css(); opts = opts || {};
    var D = el._aura || (el._aura = { tab: 'rank', period: 'this', from: '', to: '', q: '', dept: '', sort: 'period' });
    el.classList.add('au');
    el.innerHTML = '<div class="au-empty">Loading Aura Points…</div>';
    var emps, rows, sc = null, best = [];
    try {
      var r = await Promise.all([employees(), allTx(), scope().catch(function () { return null; }), db().from('best_employee_selections').select('*').eq('status', 'active').order('selected_at', { ascending: false }).limit(24)]);
      emps = r[0]; rows = r[1]; sc = r[2]; best = (r[3] && r[3].data) || [];
    } catch (e) {
      el.innerHTML = '<div class="au-empty">' + (/aura_point|relation|schema cache/i.test(e.message || '') ? 'Aura Points needs the database update 20261027_aura_points.sql.' : 'Aura Points could not load.') + '</div>'; return;
    }
    var view = sc && sc.view_departments ? sc.view_departments : (opts.mode === 'manager' || opts.mode === 'hr' ? '*' : []);
    var inView = function (e) { return view === '*' || view.indexOf(e.division) > -1; };
    var P = period(D), active = emps.filter(function (e) { return inView(e) && !['exited', 'inactive'].includes(String(e.employment_status || 'active').toLowerCase()); });
    var can = {}; ((sc && sc.eligible) || []).forEach(function (x) { can[x.id] = 1; });
    var by = {};
    rows.forEach(function (t) {
      var x = by[t.recipient_employee_id] || (by[t.recipient_employee_id] = { life: 0, per: 0, n: 0, last: '' });
      x.life += Number(t.points || 0);
      var d = istDay(t.created_at);
      if ((!P.from || d >= P.from) && (!P.to || d <= P.to)) { x.per += Number(t.points || 0); x.n++; if (d > x.last) x.last = d; }
    });
    var list = active.map(function (e) { var x = by[e.id] || { life: 0, per: 0, n: 0, last: '' }; return { e: e, life: x.life, per: x.per, n: x.n, last: x.last }; })
      .filter(function (r) { return (!D.dept || r.e.division === D.dept) && (!D.q || (r.e.full_name + ' ' + (r.e.designation || '')).toLowerCase().indexOf(D.q.toLowerCase()) > -1); });
    var key = D.sort === 'life' ? 'life' : D.sort === 'name' ? 'name' : 'per';
    list.sort(function (a, b) { return key === 'name' ? a.e.full_name.localeCompare(b.e.full_name) : (b[key] - a[key]) || (b.life - a.life) || a.e.full_name.localeCompare(b.e.full_name); });
    var depts = Object.keys(DIV).filter(function (d) { return active.some(function (e) { return e.division === d; }); });
    var curBest = best.filter(function (b) { return b.period_start === P.from && b.period_end === P.to; })[0];

    el.innerHTML = '<div class="aud">'
      + '<div class="aud-top"><div><h2>' + (view === '*' ? 'Aura Points' : esc(view.map(deptName).join(' + ') || 'Team') + ' Aura') + '</h2><p>' + (view === '*' ? 'Recognition across the organisation' : 'Recognition in your department' + (view.length > 1 ? 's' : '')) + ' · ' + esc(P.label) + '</p></div>'
      + (sc && sc.can_award ? '<button type="button" class="au-give" data-au-give style="margin-left:0">' + MARK + 'Give Aura Points</button>' : '') + '</div>'
      + '<div class="aud-bar"><div class="aud-seg" role="tablist">' + [['this', 'This month'], ['prev', 'Previous month'], ['custom', 'Custom'], ['all', 'All time']].map(function (p) { return '<button type="button" data-per="' + p[0] + '" class="' + (D.period === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('') + '</div>'
      + (D.period === 'custom' ? '<input type="date" class="au-in" data-from value="' + esc(D.from) + '" aria-label="From"><input type="date" class="au-in" data-to value="' + esc(D.to) + '" aria-label="To">' : '') + '</div>'
      + '<div class="aud-bar"><input class="au-in q" data-q placeholder="Search employee or role" value="' + esc(D.q) + '">' + (depts.length > 1 ? '<select class="au-in" data-dept data-native><option value="">All departments</option>' + depts.map(function (d) { return '<option value="' + d + '"' + (D.dept === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select>' : '')
      + '<select class="au-in" data-sort data-native><option value="period"' + (key === 'per' ? ' selected' : '') + '>Sort: points in period</option><option value="life"' + (key === 'life' ? ' selected' : '') + '>Sort: lifetime points</option><option value="name"' + (key === 'name' ? ' selected' : '') + '>Sort: name</option></select></div>'
      + '<div class="aud-tabs"><button type="button" data-tab="rank" class="' + (D.tab === 'rank' ? 'on' : '') + '">Best Employee · ranking</button><button type="button" data-tab="all" class="' + (D.tab === 'all' ? 'on' : '') + '">All employees</button></div>'
      + (D.tab === 'rank' ? rankHTML(list, P, sc, curBest, can) : tableHTML(list, can))
      + '</div>';
    wireDash(el, opts, list, P, sc);
    if (!el._auLive && window.BELive) {
      el._auLive = 'be-aura-dash-' + Math.random().toString(36).slice(2, 8);
      BELive.on(el._auLive, [{ table: 'aura_point_transactions', event: '*' }, { table: 'best_employee_selections', event: '*' }], function () {
        if (!el.isConnected) return; S.txAt = 0;
        if (!el.contains(document.activeElement) || !/INPUT|SELECT/.test(document.activeElement.tagName)) dashboard(el, opts);
      }, { debounce: 600 });
    }
  }
  function period(D) {
    if (D.period === 'prev') return monthRange(-1);
    if (D.period === 'all') return { from: '', to: '', label: 'All time' };
    if (D.period === 'custom') { var a = D.from || monthRange(0).from, b = D.to || istToday(); if (b < a) b = a; return { from: a, to: b, label: fDay(a, true) + ' – ' + fDay(b, true) }; }
    return monthRange(0);
  }
  function rowActs(id, can) {
    return '<span class="aud-act">' + (can[id] ? '<button type="button" class="au-qbtn" data-au-emp-give="' + id + '">+ Aura</button>' : '') + '<button type="button" class="au-hbtn" data-au-hist="' + id + '">History</button></span>';
  }
  function rankHTML(list, P, sc, curBest, can) {
    var ranked = list.filter(function (r) { return r.per > 0; }).sort(function (a, b) { return b.per - a.per || a.e.full_name.localeCompare(b.e.full_name); });
    // Standard competition ranking: equal points → equal rank, never broken at random.
    var pos = 0, prev = null;
    ranked.forEach(function (r, i) { if (r.per !== prev) { pos = i + 1; prev = r.per; } r.pos = pos; });
    var tieAt = {}; ranked.forEach(function (r) { tieAt[r.pos] = (tieAt[r.pos] || 0) + 1; });
    var canSel = sc && sc.can_select_best && P.from && P.to;
    var bestBox = curBest ? '<div class="aud-best">' + MARK.replace('14', '22').replace('14', '22') + '<div><div class="k">Best Employee · ' + esc(curBest.period_label || P.label) + '</div><b>' + esc(curBest.employee_name) + '</b><span>' + curBest.aura_points_during_period + ' Aura Points · selected by ' + esc(curBest.selected_by_name || '—') + ' on ' + esc(fDay(istDay(curBest.selected_at), true)) + '</span></div></div>' : '';
    if (!ranked.length) return bestBox + '<div class="au-empty">No Aura Points awarded in this period yet.</div>';
    return bestBox + (canSel ? '' : (P.from ? '' : '<div class="au-empty" style="padding:4px 0">Choose a month or custom range to select a Best Employee.</div>'))
      + '<div class="aud-rank">' + ranked.slice(0, 50).map(function (r) {
        var isBest = curBest && curBest.employee_id === r.e.id;
        return '<div class="aud-r wide' + (r.pos === 1 ? ' top' : '') + '"><span class="pos">' + r.pos + '</span>'
          + '<span class="aud-who">' + av(r.e.id, r.e.full_name) + '<span><b>' + esc(r.e.full_name) + '</b>' + (tieAt[r.pos] > 1 ? '<span class="aud-tie">TIE</span>' : '') + '<small>' + esc([DIV[r.e.division] || r.e.division, r.e.designation].filter(Boolean).join(' · ')) + '</small></span></span>'
          + '<span class="pts">' + r.per + '<small>' + r.life + ' lifetime</small></span>'
          + (canSel ? (isBest ? '<span class="aud-tie" style="color:#34d399;border-color:rgba(52,211,153,.4)">SELECTED</span>' : '<button type="button" class="aud-sel" data-best="' + r.e.id + '" data-pts="' + r.per + '">Select as Best Employee</button>') : '<span></span>')
          + rowActs(r.e.id, can) + '</div>';
      }).join('') + '</div>';
  }
  function tableHTML(list, can) {
    if (!list.length) return '<div class="au-empty">No employees match.</div>';
    return '<div class="aud-wrap"><table class="aud-tbl"><thead><tr><th>Employee</th><th>Department</th><th style="text-align:right">In period</th><th style="text-align:right">Total</th><th style="text-align:right">Awards</th><th></th></tr></thead><tbody>'
      + list.map(function (r) {
        return '<tr><td><span class="aud-who">' + av(r.e.id, r.e.full_name) + '<span><b>' + esc(r.e.full_name) + '</b><small>' + esc(r.e.designation || '') + '</small></span></span></td>'
          + '<td data-l="Department">' + esc(deptName(r.e.division) || '—') + '</td>'
          + '<td class="n" data-l="In period" style="text-align:right">' + (r.per ? '+' + r.per : '0') + '</td><td class="n" data-l="Total" style="text-align:right">' + r.life + '</td>'
          + '<td data-l="Awards" style="text-align:right">' + r.n + '</td><td>' + rowActs(r.e.id, can) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function wireDash(el, opts, list, P, sc) {
    var D = el._aura, re = function () { dashboard(el, opts); };
    el.onclick = async function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-per')) { D.period = b.getAttribute('data-per'); return re(); }
      if (b.hasAttribute('data-tab')) { D.tab = b.getAttribute('data-tab'); return re(); }
      if (b.hasAttribute('data-au-give')) return give({ onDone: re });
      if (b.hasAttribute('data-au-emp-give')) return give({ employeeId: b.getAttribute('data-au-emp-give'), onDone: re });
      if (b.hasAttribute('data-au-hist')) return openHistory(b.getAttribute('data-au-hist'));
      if (b.hasAttribute('data-best')) {
        var r = list.filter(function (x) { return x.e.id === b.getAttribute('data-best'); })[0]; if (!r) return;
        var ok = typeof window.showConfirm === 'function'
          ? await showConfirm(r.e.full_name + ' · ' + r.per + ' Aura Points in ' + P.label + '. This records management\'s final pick for the period (a later pick replaces it, history is kept).', { title: 'Select as Best Employee?', confirmLabel: 'Select' })
          : await confirmBox('Select ' + r.e.full_name + ' as Best Employee for ' + P.label + '?');
        if (!ok) return;
        b.disabled = true;
        try { await api('select_best', { employee_id: r.e.id, period_start: P.from, period_end: P.to, period_label: P.label }); pop('Best Employee selected', false, r.e.full_name + ' · ' + P.label); re(); }
        catch (x) { b.disabled = false; toast('error', x.message); }
      }
    };
    var q = el.querySelector('[data-q]'); if (q) { var t; q.oninput = function () { clearTimeout(t); t = setTimeout(function () { D.q = q.value; re(); setTimeout(function () { var n = el.querySelector('[data-q]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 0); }, 300); }; }
    var dp = el.querySelector('[data-dept]'); if (dp) dp.onchange = function () { D.dept = dp.value; re(); };
    var so = el.querySelector('[data-sort]'); if (so) so.onchange = function () { D.sort = so.value; re(); };
    var f = el.querySelector('[data-from]'), to = el.querySelector('[data-to]');
    if (f) f.onchange = function () { D.from = f.value; re(); }; if (to) to.onchange = function () { D.to = to.value; re(); };
  }
  function confirmBox(msg) {
    return new Promise(function (res) {
      var ov = document.createElement('div'); ov.className = 'au-ov au';
      ov.innerHTML = '<div class="au-dlg"><h3>' + esc(msg) + '</h3><div class="au-acts"><button class="au-btn" data-n>Cancel</button><button class="au-btn pri" data-y>Confirm</button></div></div>';
      document.body.appendChild(ov);
      ov.querySelector('[data-n]').onclick = function () { ov.remove(); res(false); };
      ov.querySelector('[data-y]').onclick = function () { ov.remove(); res(true); };
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Signed-in employee's own Aura: header ring, hover card, account-menu row, My Aura
  // ════════════════════════════════════════════════════════════════════════
  async function loadMine() {
    if (!S.me) return null;
    var rows = await txFor(S.me), m = monthRange(0), month = sum(rows, m.from, m.to);
    var rank = 0;
    if (month > 0) {   // rank only when it means something (I have points this month)
      try {
        var r = await db().from('aura_point_transactions').select('recipient_employee_id,points').eq('status', 'active').gte('created_at', m.from + 'T00:00:00+05:30').lte('created_at', m.to + 'T23:59:59.999+05:30').limit(5000);
        var by = {}; (r.data || []).forEach(function (t) { by[t.recipient_employee_id] = (by[t.recipient_employee_id] || 0) + Number(t.points || 0); });
        rank = 1 + Object.keys(by).filter(function (k) { return by[k] > month; }).length;
      } catch (_) {}
    }
    S.mine = { rows: rows, life: sum(rows), month: month, n: rows.filter(function (t) { return t.status === 'active'; }).length, rank: rank };
    paintHeader();
    return S.mine;
  }
  function menuRow() {
    var M = S.mine; if (!M) return '';
    return '<button class="am-item au-mrow" data-am-action="aura">' + MARK + '<span>Aura Points</span><span class="au-mv"><b>' + M.life.toLocaleString('en-IN') + '</b>' + (M.month > 0 ? '<small>+' + M.month + ' this month</small>' : '') + '</span></button>';
  }
  function avatars() { return Array.prototype.slice.call(document.querySelectorAll('.bes-account .bes-av')); }
  function paintHeader() {
    if (!S.mine) return; css();
    avatars().forEach(function (av) {
      var w = av.parentNode;
      if (!w.classList.contains('au-avw')) {
        w = document.createElement('span'); w.className = 'au-avw';
        av.parentNode.insertBefore(w, av); w.appendChild(av);
        var ring = document.createElement('span'); ring.className = 'au-ring'; ring.setAttribute('aria-hidden', 'true'); w.appendChild(ring);
        hoverCard(w.closest('.bes-account'), w);
      }
      var acct = w.closest('.bes-account'), tag = acct.querySelector('.au-tag');
      if (!tag) {
        tag = document.createElement('span'); tag.className = 'au-tag'; tag.setAttribute('role', 'button'); tag.tabIndex = -1;
        tag.title = 'My Aura';
        tag.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); hideCard(); openMine(); });
        var who = acct.querySelector('.bes-who'); (who || w).insertAdjacentElement('afterend', tag);
      }
      tag.innerHTML = MARK + 'Aura ' + S.mine.life.toLocaleString('en-IN');
      acct.setAttribute('aria-label', 'Account menu · ' + S.mine.life + ' Aura Points');
    });
  }
  var HC = { el: null, t: 0 };
  function hideCard() { clearTimeout(HC.t); if (HC.el) HC.el.classList.remove('on'); }
  function hoverCard(acct, ringWrap) {
    if (!acct || !window.matchMedia || !matchMedia('(hover:hover) and (pointer:fine)').matches) return;   // touch: account menu carries the Aura row
    acct.addEventListener('mouseenter', function () {
      clearTimeout(HC.t);
      HC.t = setTimeout(function () {
        if (!S.mine || document.querySelector('.am-dropdown.am-open')) return;
        if (!HC.el) {
          HC.el = document.createElement('div'); HC.el.className = 'au-hc au'; HC.el.setAttribute('role', 'tooltip'); document.body.appendChild(HC.el);
          HC.el.addEventListener('mouseenter', function () { clearTimeout(HC.t); });
          HC.el.addEventListener('mouseleave', function () { HC.t = setTimeout(hideCard, 160); });
        }
        var M = S.mine;
        HC.el.innerHTML = '<span class="au-k">' + MARK + 'Aura Points</span><span class="au-v" style="display:block">' + M.life.toLocaleString('en-IN') + '</span>'
          + '<div class="row"><div><span class="au-k">This Month</span><div class="au-sm' + (M.month > 0 ? ' pos' : '') + '">' + (M.month > 0 ? '+' : '') + M.month + '</div></div>'
          + (M.rank ? '<div><span class="au-k">Rank</span><div class="au-sm">#' + M.rank + '</div></div>' : '') + '</div>'
          + '<button type="button" class="au-link">View Aura History</button>';
        HC.el.querySelector('.au-link').onclick = function () { hideCard(); openMine(); };
        var r = ringWrap.getBoundingClientRect(), W = 248;
        HC.el.style.top = Math.round(r.bottom + 10) + 'px';
        HC.el.style.left = Math.round(Math.max(12, Math.min(window.innerWidth - W - 12, r.left + r.width / 2 - W + 40))) + 'px';
        HC.el.classList.add('on');
      }, 380);
    });
    acct.addEventListener('mouseleave', function () { clearTimeout(HC.t); HC.t = setTimeout(hideCard, 160); });
    acct.addEventListener('click', hideCard);
  }
  function pulse() {
    document.querySelectorAll('.au-avw').forEach(function (w) { w.classList.remove('pulse'); void w.offsetWidth; w.classList.add('pulse'); setTimeout(function () { w.classList.remove('pulse'); }, 4400); });
  }
  async function openMine() {
    css();
    var ov = document.createElement('div'); ov.className = 'au-ov au';
    ov.innerHTML = '<div class="au-dlg au-mine" role="dialog" aria-modal="true" aria-label="My Aura"><h3>My Aura</h3><div class="au-empty">Loading…</div></div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var M = null;
    try { M = await loadMine(); } catch (_) {}
    var dlg = ov.querySelector('.au-dlg');
    if (!M) { dlg.innerHTML = '<h3>My Aura</h3><div class="au-empty">Aura Points could not load right now.</div><div class="au-acts"><button type="button" class="au-btn" data-x>Close</button></div>'; dlg.querySelector('[data-x]').onclick = close; return; }
    dlg.innerHTML = '<h3>My Aura</h3><p class="sub">Recognition from your Head and Managers' + (M.rank ? ' · #' + M.rank + ' this month' : '') + '</p>'
      + statsHTML(M.life, M.month, M.n, 0)
      + '<div class="au-rh" style="margin-top:4px"><span>Recent recognitions</span></div>'
      + '<div class="au-hist">' + history(M.rows, { self: true, limit: 40 }) + '</div>'
      + '<div class="au-acts"><button type="button" class="au-btn" data-x>Close</button></div>';
    dlg.querySelector('[data-x]').onclick = close;
  }

  // ── any employee's Aura history (dashboard rows) ──────────────────────────
  async function openHistory(empId) {
    css();
    var ov = document.createElement('div'); ov.className = 'au-ov au';
    ov.innerHTML = '<div class="au-dlg au-mine" role="dialog" aria-modal="true" aria-label="Aura history"><h3>Aura History</h3><div class="au-empty">Loading…</div></div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var dlg = ov.querySelector('.au-dlg'), emps = [], rows = [];
    try { emps = await employees(); rows = await txFor(empId); } catch (_) {}
    var e = emps.filter(function (x) { return x.id === empId; })[0] || { id: empId, full_name: 'Employee' };
    var m = monthRange(0), act = rows.filter(function (t) { return t.status === 'active'; }).length;
    var canGive = false; try { canGive = ((await scope()).eligible || []).some(function (x) { return x.id === empId; }); } catch (_) {}
    dlg.innerHTML = '<div style="display:flex;align-items:center;gap:12px">' + av(e.id, e.full_name) + '<div style="min-width:0"><h3 style="margin:0">' + esc(e.full_name) + '</h3><p class="sub" style="margin:2px 0 0">' + esc([e.designation, deptName(e.division)].filter(Boolean).join(' · ')) + '</p></div></div>'
      + statsHTML(sum(rows), sum(rows, m.from, m.to), act, 0)
      + '<div class="au-rh" style="margin-top:4px"><span>Aura History</span></div><div class="au-hist">' + history(rows, { limit: 60 }) + '</div>'
      + '<div class="au-acts">' + (canGive ? '<button type="button" class="au-btn" data-g>+ Give Aura Points</button>' : '') + '<button type="button" class="au-btn" data-x>Close</button></div>';
    dlg.querySelector('[data-x]').onclick = close;
    var g = dlg.querySelector('[data-g]'); if (g) g.onclick = function () { close(); give({ employeeId: empId }); };
  }

  // ── dashboard as a page-level panel (pages without their own Aura section) ─────
  function openDashboard() {
    css();
    var sh = document.createElement('div'); sh.className = 'au-sheet au';
    sh.innerHTML = '<div class="au-pane" role="dialog" aria-modal="true" aria-label="Aura Points"><button type="button" class="au-x" aria-label="Close">×</button><div data-dash></div></div>';
    document.body.appendChild(sh);
    var close = function () { sh.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape' && !document.querySelector('.au-ov')) close(); };
    document.addEventListener('keydown', key);
    sh.addEventListener('click', function (e) { if (e.target === sh) close(); });
    sh.querySelector('.au-x').onclick = close;
    dashboard(sh.querySelector('[data-dash]'), {});
  }

  // ── once the signed-in person's authority is known ───────────────────────────
  function applyScope(sc) {
    if (!sc) return; css();
    // "+ Aura" quick buttons anywhere in the ERP: <button data-au-quick="<employee id>"> stay
    // hidden unless that employee is inside my server-computed award scope.
    var st = document.getElementById('aura-quick-css') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'aura-quick-css' }));
    st.textContent = (sc.eligible || []).length ? sc.eligible.map(function (x) { return '[data-au-quick="' + String(x.id).replace(/[^\w-]/g, '') + '"]'; }).join(',') + '{display:inline-grid!important;place-items:center}' : '';
    // Nav entry on department pages (HR + Manager pages have their own Aura section).
    if (!(sc.can_award || sc.view_departments === '*') || document.getElementById('hr-sub-aura') || document.getElementById('mgr-aura')) return;
    var links = document.querySelectorAll('#nav-acad-announcements, #nav-announcements, .sidebar-link[data-tab="announcements"], .sidebar-link[onclick*="\'announcements\'"]');
    Array.prototype.forEach.call(links, function (a) {
      if (a._auNav || (a.nextElementSibling && a.nextElementSibling.classList.contains('au-nav-aura'))) return; a._auNav = true;
      var b = document.createElement('button'); b.type = 'button';
      b.className = String(a.className).replace(/\bactive\b/g, '').replace(/\bhidden\b/g, '') + ' au-nav-aura';
      b.setAttribute('style', a.getAttribute('style') || '');
      b.innerHTML = MARK + ' <span class="be-nav-label">Aura Points</span>';
      b.onclick = function () { try { if (typeof closeMobileSidebar === 'function') closeMobileSidebar(); } catch (_) {} openDashboard(); };
      a.insertAdjacentElement('afterend', b);
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-au-quick]'); if (!b) return;
    e.preventDefault(); e.stopPropagation(); give({ employeeId: b.getAttribute('data-au-quick') });
  }, true);

  // ── live toast for the signed-in employee ──────────────────────────────────
  async function watch() {
    if (S.watching) return; S.watching = true;
    var email = B().currentEmail ? String(B().currentEmail() || '').toLowerCase() : '';
    if (!email || !db()) return;
    scopeCached();
    setTimeout(function () { scope().then(applyScope).catch(function () {}); }, 400);   // prefetch for the Give dialog
    var r = await db().from('hr_employees').select('id').ilike('portal_email', email.replace(/[\\%_]/g, function (c) { return '\\' + c; })).limit(1);
    var me = r.data && r.data[0]; if (!me) return;
    S.me = me.id;
    loadMine().catch(function () {});
    // The header can be (re)built after us — keep the ring on it.
    var mo = new MutationObserver(function () { if (S.mine && avatars().some(function (a) { return !a.parentNode.classList.contains('au-avw'); })) paintHeader(); });
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('be-aura-changed', function () { loadMine().catch(function () {}); });
    if (!window.BELive) return;
    BELive.on('be-aura-me', [{ table: 'aura_point_transactions', filter: 'recipient_employee_id=eq.' + me.id, event: 'INSERT' }], function (evs) {
      (evs || []).forEach(function (p) {
        var n = p && p.new; if (!n || n.status !== 'active' || Number(n.points) <= 0) return;
        try { var seen = JSON.parse(localStorage.getItem('be_aura_seen') || '[]'); if (seen.indexOf(n.id) > -1) return; seen.push(n.id); localStorage.setItem('be_aura_seen', JSON.stringify(seen.slice(-50))); } catch (_) {}
        pop('+' + n.points + ' Aura', false, n.reason + (n.awarded_by_name ? ' — ' + n.awarded_by_name : ''));
        pulse();
      });
      document.dispatchEvent(new CustomEvent('be-aura-changed'));
    }, { debounce: 0 });
  }

  window.BEAura = { mountProfile: mountProfile, dashboard: dashboard, give: give, watch: watch, scope: scope, menuRow: menuRow, openMine: openMine, refreshMine: loadMine, openHistory: openHistory, openDashboard: openDashboard };
  // Auto: start the live toast once someone is signed in (not inside embedded frames).
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
  if (!embedded) { var tries = 0; (function w() { if (B().currentEmail && B().currentEmail()) return watch(); if (++tries < 60) setTimeout(w, 2000); })(); }
})();
