#!/usr/bin/env node
// Requires agent-browser on PATH and a Vite demo server:
// VITE_DEMO=1 npm -w @termany/web run dev -- --host 127.0.0.1 --port 5188
// node scripts/retro-theme-smoke.mjs http://127.0.0.1:5188
// Uses an isolated browser session and refuses a non-demo app before editing it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5188');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local demo server');
const session = `retro-qa-${process.pid}`;
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 });
const evaluate = (code) => JSON.parse(run('eval', code));
const check = (code, description) => assert.ok(evaluate(code), description);
const menuButton = '.pane-slot.focused .pane-view-btn';
const settled = () => evaluate('(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()');
const fits = (selector) => evaluate(`(() => {
  const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
  return r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7;
})()`);
try {
  run('open', url.href);
  check('(async () => (await import("/src/demo.ts")).isDemo)()', 'Refusing to modify a non-demo workspace');
  const modifier = evaluate('/Mac|iPhone|iPad/.test(navigator.platform)') ? 'Meta' : 'Control';
  for (const theme of ['winxp', 'aqua', 'bsod', 'excel']) {
    run('set', 'viewport', '1440', '900');
    evaluate(`localStorage.setItem('termany.theme', ${JSON.stringify(theme)})`);
    run('reload');
    run('click', menuButton);
    check(`(() => {
      const e = document.querySelector('.pane-view-panel [role=menuitem]'), r = e.getBoundingClientRect();
      return [r.left + 4, r.right - 4].every(x => e.contains(document.elementFromPoint(x, r.top + r.height / 2)));
    })()`, `${theme}: both edges of the menu item must actually receive pointer events`);
    run('press', 'End');
    check(`document.activeElement === [...document.querySelectorAll('.pane-view-panel [role=menuitem]')].at(-1)`, `${theme}: keyboard End`);
    run('press', 'Escape');
    check(`!document.querySelector('.pane-view-panel') && document.activeElement.matches('.pane-view-btn')`, `${theme}: Escape restores trigger focus`);
    run('click', menuButton);
    run('press', `${modifier}+,`);
    check(`!!document.querySelector('.settings-window') && !document.querySelector('.pane-view-panel')`, `${theme}: settings shortcut dismisses the menu`);
    run('click', '.settings-close');
    run('click', menuButton);
    run('click', '.pane-view-panel [role=menuitem]:nth-child(2)');
    check(`!!document.querySelector('.pane-slot.focused .file-tree')`, `${theme}: clicking Files must switch the view, not merely dismiss the popup`);
    run('dblclick', '.pane-slot.focused .pane-head-title');
    run('fill', '.pane-head-rename', '生产环境日志 / production-logs-with-a-very-long-title');
    run('press', 'Enter');
    check(`(() => {
      const h = document.querySelector('.pane-slot.focused .pane-head');
      const t = h.querySelector('.pane-head-name').getBoundingClientRect();
      const a = h.querySelector('.pane-head-actions').getBoundingClientRect();
      return t.right <= a.left || a.right <= t.left;
    })()`, `${theme}: long title does not overlap actions`);
    run('click', menuButton);
    run('press', 'Home');
    run('press', 'Enter');
    check(`!!document.querySelector('.pane-slot.focused .term-pane')`, `${theme}: keyboard activation returns to terminal`);
    run('click', '.pane-slot.focused [data-pane-action=zoom]');
    run('click', '.zen-pane .pane-view-btn');
    check(`document.querySelector('.pane-view-panel').contains(document.elementFromPoint(...(() => {const r=document.querySelector('.pane-view-panel').getBoundingClientRect();return [r.left+8,r.top+8]})()))`, `${theme}: menu is above the zen pane`);
    run('press', 'Escape');
    run('click', '.zen-pane [data-pane-action=zoom]');
    run('set', 'viewport', '900', '240');
    run('click', menuButton);
    assert.ok(fits('.pane-view-panel'), `${theme}: short-window menu fits`);
    run('scroll', 'down', '200', '--selector', '.pane-view-panel');
    settled();
    const scrollTop = evaluate(`document.querySelector('.pane-view-panel').scrollTop`);
    settled();
    assert.ok(scrollTop > 0, `${theme}: menu can scroll`);
    assert.equal(evaluate(`document.querySelector('.pane-view-panel').scrollTop`), scrollTop, `${theme}: positioning must not reset menu scroll`);
    run('press', 'Escape');
    run('click', '.pane-slot.focused .pane-connection-trigger');
    settled();
    assert.ok(fits('.pane-connection-menu'), `${theme}: SSH popup fits`);
    run('click', '.pane-connection-menu input');
    run('fill', '.pane-connection-menu input', 'qa-host');
    check(`document.querySelector('.pane-connection-menu input')?.value === 'qa-host'`, `${theme}: popup input retains focus`);
    run('press', `${modifier}+a`);
    check(`!!document.querySelector('.pane-connection-menu input') && document.activeElement.matches('.pane-connection-menu input')`, `${theme}: native text-editing shortcuts keep the SSH field open`);
    run('press', 'Escape');
    console.log(`${theme}: pointer hit testing, view switching, keyboard navigation, zen, short viewport, scrolling, SSH input passed`);
  }
} finally {
  run('close');
}
