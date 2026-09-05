/* Composer actions menu — the single "+" at the left of the Fleet Console that
 * gathers the buttons that used to float around the command bar (spawn agents,
 * settings) plus a clear-conversation action, behind one component. The actual
 * work is injected from main.ts so this module stays free of the spawn/settings
 * import graph. */

export interface ComposerActionDeps {
  onSpawn: () => void;
  onSettings: () => void;
  onClear: () => void;
}

/** Wire the "+" actions button + its menu. Safe no-op if the markup is absent. */
export function initComposerActions(deps: ComposerActionDeps): void {
  const wrap = document.getElementById("cbActionsWrap");
  const btn = document.getElementById("cbActions");
  const menu = document.getElementById("cbActionsMenu");
  if (!wrap || !btn || !menu) return;

  let open = false;
  const close = (): void => {
    if (!open) return;
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    open = false;
  };
  const show = (): void => {
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
    open = true;
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) close();
    else show();
  });

  for (const item of menu.querySelectorAll<HTMLElement>(".cb-am-item")) {
    item.addEventListener("click", () => {
      close();
      switch (item.dataset.act) {
        case "spawn":
          deps.onSpawn();
          break;
        case "settings":
          deps.onSettings();
          break;
        case "clear":
          deps.onClear();
          break;
      }
    });
  }

  document.addEventListener("mousedown", (e) => {
    if (open && !wrap.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation(); // don't also collapse the console thread
      close();
    }
  });
}
