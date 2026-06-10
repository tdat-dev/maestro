/**
 * Pixel-art mascot player (character + Shiba pet).
 *
 * Sprites live in ./assets/sprites/ as uniform-cell horizontal strips, with
 * geometry described by sprites.json. Animation is driven by the Web Animations
 * API (background-position + steps() easing) so loops, one-shots, and
 * return-to-idle are all handled without injecting CSS.
 *
 *   const m = new Mascot(container, { scale: 2 });
 *   m.play('walk');               // loops
 *   m.play('jump');               // plays once, then auto-returns to idle
 *   m.play('attack', { then: 'idle' });
 */
import manifest from './assets/sprites/sprites.json';

// Vite: resolve every strip PNG to a hashed URL at build time.
const urls = import.meta.glob('./assets/sprites/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export type AnimName = keyof typeof manifest;

interface AnimMeta {
  frames: number;
  frameW: number;
  frameH: number;
  fps: number;
  loop: boolean;
  /** true for high-res illustration strips (smooth scaling instead of pixelated) */
  smooth?: boolean;
  /** ping-pong the loop (forward then reverse) — hides a non-seamless wrap */
  bounce?: boolean;
}

const META = manifest as Record<string, AnimMeta>;

function urlFor(name: string): string {
  const key = `./assets/sprites/${name}.png`;
  const u = urls[key];
  if (!u) throw new Error(`mascot: missing sprite "${name}.png"`);
  return u;
}

/** Pixel sprites look best at integer scale; allow fractional down to 0.1 for smooth strips. */
function clampScale(scale: number): number {
  const s = Number.isFinite(scale) ? scale : 1;
  return Math.max(0.1, Number.isInteger(s) ? s : Math.round(s * 100) / 100);
}

export interface MascotOptions {
  /** integer pixel scale (1 = native). default 2 */
  scale?: number;
  /** animation to start on. default 'idle' (falls back to first available) */
  initial?: string;
}

export class Mascot {
  readonly el: HTMLDivElement;
  private scale: number;
  private current = '';
  private anim?: Animation;
  private idleName: string;
  private facing: 'left' | 'right' = 'right';

  /** Decode strips up front so swapping a (large) background-image is instant —
   *  otherwise a big strip can flash blank for a frame while it decodes. */
  static async preload(names: string[]): Promise<void> {
    await Promise.all(
      names
        .filter((n) => META[n])
        .map((n) => {
          const img = new Image();
          img.src = urlFor(n);
          return img.decode().catch(() => {});
        }),
    );
  }

  constructor(parent: HTMLElement, opts: MascotOptions = {}) {
    this.scale = clampScale(opts.scale ?? 2);
    this.idleName = META['idle'] ? 'idle' : Object.keys(META)[0];
    this.el = document.createElement('div');
    this.el.className = 'mascot';
    Object.assign(this.el.style, {
      backgroundRepeat: 'no-repeat',
      transformOrigin: 'bottom center',
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.el);
    this.play(opts.initial ?? this.idleName);
  }

  /** List every available animation name. */
  static animations(): string[] {
    return Object.keys(META);
  }

  /** Play an animation. Non-looping anims return to `then` (default: idle) when done. */
  play(name: string, opts: { then?: string } = {}): void {
    const m = META[name];
    if (!m) {
      console.warn(`mascot: unknown animation "${name}"`);
      return;
    }
    if (name === this.current && this.anim?.playState === 'running') return;
    this.current = name;
    this.anim?.cancel();

    const { frameW, frameH, frames, fps, loop } = m;
    Object.assign(this.el.style, {
      width: `${frameW}px`,
      height: `${frameH}px`,
      backgroundImage: `url("${urlFor(name)}")`,
      imageRendering: m.smooth ? 'auto' : 'pixelated',
    } as Partial<CSSStyleDeclaration>);
    this.applyTransform(); // re-assert scale + facing (don't let a play() drop the flip)

    this.anim = this.el.animate(
      [
        { backgroundPositionX: '0px' },
        { backgroundPositionX: `-${frameW * frames}px` },
      ],
      {
        duration: (frames / fps) * 1000,
        iterations: loop ? Infinity : 1,
        direction: m.bounce ? 'alternate' : 'normal',
        easing: `steps(${frames})`,
        fill: 'forwards',
      },
    );

    if (!loop) {
      const back = opts.then ?? this.idleName;
      this.anim.onfinish = () => {
        if (this.current === name && back && META[back]) this.play(back);
      };
    }
  }

  setScale(scale: number): void {
    this.scale = clampScale(scale);
    this.applyTransform();
  }

  /** Mirror horizontally (e.g. when walking left). Sprites face right by default. */
  setFacing(dir: 'left' | 'right'): void {
    this.facing = dir;
    this.applyTransform();
  }

  private applyTransform(): void {
    const flip = this.facing === 'left' ? ' scaleX(-1)' : '';
    this.el.style.transform = `scale(${this.scale})${flip}`;
  }

  destroy(): void {
    this.anim?.cancel();
    this.el.remove();
  }
}
