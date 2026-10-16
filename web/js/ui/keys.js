// Keyboard shortcuts: digits pick menu items, Enter/Space trigger the primary action,
// Backspace goes back a step. Escape is handled by the modal. Each screen registers its
// current buttons with bind(); real <button>s keep their own Enter/Space behaviour.

import { modalOpen } from './modal.js';

let current = {};

/** Register the shortcuts for what is on screen now: { '1': button, primary: button, back: button }. */
export function bind(map) {
  current = map || {};
}

function usable(btn) {
  return btn && btn.isConnected && !btn.disabled && btn.offsetParent !== null;
}

export function installKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || modalOpen()) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    if (typing) return;
    const onControl = el && el !== document.body && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.tagName === 'SUMMARY');
    let target = null;
    if (/^[0-9]$/.test(e.key)) target = current[e.key];
    else if ((e.key === 'Enter' || e.key === ' ') && !onControl) target = current.primary;
    else if (e.key === 'Backspace') target = current.back;
    if (usable(target)) {
      e.preventDefault();
      target.click();
    }
  });
}
