/* Freeze decorative CSS animations whenever the window isn't being looked at —
 * hidden (minimized to tray / minimized) or unfocused — so the WebView stops
 * burning GPU on the animated home logo while it sits in the background.
 *
 * The workspace/terminal view needs no special handling: #home is display:none
 * there, which already halts its animations. */

/** Whether decorative animations should be paused for the given window state. */
export function shouldPauseAnimations(hidden: boolean, focused: boolean): boolean {
  return hidden || !focused;
}

/** Wire visibility/focus listeners so `body.anim-paused` mirrors the window
 *  state. CSS pauses every running animation while that class is present.
 *
 *  `onResume` fires once each time the window goes from not-looked-at (hidden or
 *  unfocused) back to visible+focused. WebView2 can drop its GPU compositing
 *  surface to black after a long idle / display sleep / minimize-to-tray; the
 *  caller uses this hook to force a repaint so the app doesn't come back black. */
export function initIdleAnimationPause(onResume?: () => void): void {
  let paused = false;
  const apply = () => {
    const pause = shouldPauseAnimations(document.hidden, document.hasFocus());
    document.body.classList.toggle("anim-paused", pause);
    if (pause !== paused) {
      // Instrumentation: pairs with the webgl-context-loss log so the next time
      // the screen goes black we can tell whether it was idle/GPU-related.
      console.debug(
        `[maestro] window ${pause ? "idle" : "active"} ` +
          `(hidden=${document.hidden}, focused=${document.hasFocus()})`,
      );
      if (paused && !pause) {
        console.info("[maestro] window resumed → forcing repaint");
        onResume?.();
      }
      paused = pause;
    }
  };
  document.addEventListener("visibilitychange", apply);
  window.addEventListener("blur", apply);
  window.addEventListener("focus", apply);
  apply();
}
