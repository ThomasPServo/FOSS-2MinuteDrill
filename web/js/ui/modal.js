// Accessible modal dialogs: focus moves in and is restored, Tab stays inside, Escape and a
// backdrop click close.

import { h } from './dom.js';
import { icon } from './icons.js';

let open = null;

export const modalOpen = () => open !== null;

/** Close the open modal, if any. */
function closeModal() {
  open?.close();
}

/** Open a dialog with a title and body nodes. Returns a close function. */
export function openModal(title, body) {
  closeModal();
  const previous = document.activeElement;
  const closeBtn = h('button', { class: 'icon-btn modal-close', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const titleId = `modal-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    closeBtn, h('h2', { id: titleId }, title), body);
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function close() {
    if (open?.backdrop !== backdrop) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    document.body.classList.remove('has-modal');
    if (previous && document.contains(previous)) previous.focus();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  document.body.classList.add('has-modal');
  open = { backdrop, close };
  closeBtn.focus();
  return close;
}
