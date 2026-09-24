// In-app confirm modal. Unlike the native dialog it can carry a "Don't ask
// again" checkbox and an optional text input, and resolves a structured result.
// Split from workspace.ts; pure DOM (no app imports) so spawn/wizard/workspace
// can all share it without a circular dependency.

/** Tab and Shift+Tab stay inside the top dialog (New agent, the palette,
 *  Help, Compare, Settings, a confirm) instead of walking out into the app
 *  behind it. Install once at startup. */
export function installModalTrap(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const layers = [...document.querySelectorAll<HTMLElement>(".inbox-modal-back, .backdrop.open")];
    const top = layers[layers.length - 1];
    if (!top) return;
    const box = top.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"], .modal') ?? top;
    const all = [...box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !box.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !box.contains(at))) { e.preventDefault(); first.focus(); }
  }, true);
}

/** In-app confirm modal (unlike the native dialog, it can carry a "Don't ask
 *  again" checkbox). Resolves { ok, dontAsk, value }. `danger` paints the
 *  confirm button red and starts on Cancel, so a stray Enter is harmless. */
export function confirmModal(opts: {
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
  dontAsk?: boolean;
  input?: { placeholder?: string; value?: string };
}): Promise<{ ok: boolean; dontAsk: boolean; value: string }> {
  const m = document.getElementById("confirmModal") as HTMLElement;
  const okBtn = document.getElementById("cfOk") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cfCancel") as HTMLButtonElement;
  const dontChk = document.getElementById("cfDontask") as HTMLInputElement;
  const inputRow = document.getElementById("cfInputRow") as HTMLElement;
  const inputEl = document.getElementById("cfInput") as HTMLInputElement;
  const back = document.activeElement as HTMLElement | null;
  document.getElementById("cfTitle")!.textContent = opts.title;
  document.getElementById("cfMsg")!.textContent = opts.message;
  okBtn.textContent = opts.okLabel ?? "Confirm";
  okBtn.classList.toggle("danger", !!opts.danger);
  (document.getElementById("cfDontaskRow") as HTMLElement).hidden = !opts.dontAsk;
  dontChk.checked = false;
  inputRow.hidden = !opts.input;
  if (opts.input) {
    inputEl.placeholder = opts.input.placeholder ?? "";
    inputEl.value = opts.input.value ?? "";
  }
  m.classList.add("open");
  if (opts.input) {
    inputEl.focus();
    inputEl.select();
  } else {
    (opts.danger ? cancelBtn : okBtn).focus();
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      m.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      m.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus();
      resolve({ ok, dontAsk: dontChk.checked, value: inputEl.value });
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === m) done(false);
    };
    // Enter confirms only from the text field; on a button it presses that
    // button (Cancel stays Cancel).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter" && e.target === inputEl) { e.preventDefault(); done(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    m.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey, true);
  });
}
