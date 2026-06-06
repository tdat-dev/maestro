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
 *  state. CSS pauses every running animation while that class is present. */
export function initIdleAnimationPause(): void {
  const apply = () => {
    const pause = shouldPauseAnimations(document.hidden, document.hasFocus());
    document.body.classList.toggle("anim-paused", pause);
  };
  document.addEventListener("visibilitychange", apply);
  window.addEventListener("blur", apply);
  window.addEventListener("focus", apply);
  apply();
}
