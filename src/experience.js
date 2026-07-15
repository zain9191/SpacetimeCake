// Shared product-level UI helpers. Keeping these independent of Three.js lets
// the video, detection and tracking modules report progress without cycles.

export function setWorkflowStep(step) {
  const root = document.getElementById('workflow');
  if (!root) return;
  root.dataset.step = String(step);
  root.querySelectorAll('.workflow-step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
    el.setAttribute('aria-current', n === step ? 'step' : 'false');
  });
}

export function setWorkspaceReady(ready) {
  const controls = document.getElementById('workspace-controls');
  if (!controls) return;
  controls.classList.toggle('ready', ready);
  controls.toggleAttribute('inert', !ready);
  controls.setAttribute('aria-hidden', String(!ready));
}

export function showNotice(message, type = 'info', { persistent = false } = {}) {
  const notice = document.getElementById('notice');
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice active ${type}`;
  notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
  clearTimeout(showNotice.timer);
  if (!persistent) {
    showNotice.timer = setTimeout(() => notice.classList.remove('active'), 4500);
  }
}

export function clearNotice() {
  clearTimeout(showNotice.timer);
  document.getElementById('notice')?.classList.remove('active');
}
