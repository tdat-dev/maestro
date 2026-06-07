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
}

const META = manifest as Record<string, AnimMeta>;

function urlFor(name: string): string {
  const key = `./assets/sprites/${name}.png`;
  const u = urls[key];
  if (!u) throw new Error(`mascot: missing sprite "${name}.png"`);
  return u;
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

  constructor(parent: HTMLElement, opts: MascotOptions = {}) {
    this.scale = Math.max(1, Math.round(opts.scale ?? 2));
    this.idleName = META['idle'] ? 'idle' : Object.keys(META)[0];
    this.el = document.createElement('div');
    this.el.className = 'mascot';
    Object.assign(this.el.style, {
      imageRendering: 'pixelated',
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
      transform: `scale(${this.scale})`,
    } as Partial<CSSStyleDeclaration>);

    this.anim = this.el.animate(
      [
        { backgroundPositionX: '0px' },
        { backgroundPositionX: `-${frameW * frames}px` },
      ],
      {
        duration: (frames / fps) * 1000,
        iterations: loop ? Infinity : 1,
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
    this.scale = Math.max(1, Math.round(scale));
    this.el.style.transform = `scale(${this.scale})`;
  }

  /** Mirror horizontally (e.g. when walking left). */
  setFacing(dir: 'left' | 'right'): void {
    const flip = dir === 'left' ? ' scaleX(-1)' : '';
    this.el.style.transform = `scale(${this.scale})${flip}`;
  }

  destroy(): void {
    this.anim?.cancel();
    this.el.remove();
  }
}
