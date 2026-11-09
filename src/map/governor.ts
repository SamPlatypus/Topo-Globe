/**
 * Automatic frame-rate step-down for budget phones.
 *
 * While the map is drawing, frame intervals are sampled.  If the median frame
 * stays slower than ~18 fps the governor steps quality down (render
 * resolution, then contour labels and slope shading, then terrain mesh
 * exaggeration/pitch, finally flat 2D) so the map keeps moving instead of
 * freezing; when frames are consistently fast it steps back up, slowly.  A
 * single frame longer than one second drops two levels at once.
 */
import type { Map as MlMap } from 'maplibre-gl';

export interface QualityLevel {
  pixelRatio: number;
  labels: boolean;
  slope: boolean;
  terrain: boolean;
  maxPitch: number;
  label: string;
}

export class FrameGovernor {
  level = 0;
  readonly levels: QualityLevel[];
  private samples: number[] = [];
  private last = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private lastChange = 0;
  private windowStart = 0;
  onChange: (lvl: QualityLevel, index: number) => void = () => undefined;

  constructor(private readonly map: MlMap, dpr = window.devicePixelRatio || 1) {
    const top = Math.min(dpr, 2);
    this.levels = [
      { pixelRatio: top, labels: true, slope: true, terrain: true, maxPitch: 75, label: 'full quality' },
      { pixelRatio: Math.min(top, 1.5), labels: true, slope: true, terrain: true, maxPitch: 75, label: 'reduced resolution' },
      { pixelRatio: Math.min(top, 1.0), labels: true, slope: true, terrain: true, maxPitch: 70, label: 'low resolution' },
      { pixelRatio: Math.min(top, 0.85), labels: false, slope: false, terrain: true, maxPitch: 60, label: 'low detail' },
      { pixelRatio: Math.min(top, 0.7), labels: false, slope: false, terrain: false, maxPitch: 0, label: 'flat 2D (saving power)' },
    ];
    map.on('render', () => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    if (this.last && now - this.last < 2000) {
      const dt = now - this.last;
      this.samples.push(dt);
      if (dt > 1000 && now - this.lastChange > 1500 && this.pinned === null) {
        this.step(+2);
        return;
      }
    }
    this.last = now;
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart >= 1000) {
      this.evaluate(now);
      this.windowStart = now;
      this.samples = [];
    }
  }

  /** Pin a quality level (diagnostics / automated checks); null resumes automatic control. */
  pinned: number | null = null;
  pin(level: number | null): void {
    this.pinned = level;
    if (level !== null) {
      this.level = level;
      this.apply();
    }
  }

  private evaluate(now: number): void {
    if (this.pinned !== null) return;
    if (this.samples.length < 8) return; // map was mostly idle
    const s = this.samples.slice().sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    if (median > 55) {
      this.slowWindows++;
      this.fastWindows = 0;
      if (this.slowWindows >= 2 && now - this.lastChange > 2500) this.step(+1);
    } else if (median < 24) {
      this.fastWindows++;
      this.slowWindows = 0;
      if (this.fastWindows >= 6 && this.level > 0 && now - this.lastChange > 10000) this.step(-1);
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }
  }

  step(delta: number): void {
    const next = Math.max(0, Math.min(this.levels.length - 1, this.level + delta));
    if (next === this.level) return;
    this.level = next;
    this.lastChange = performance.now();
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.apply();
  }

  apply(): void {
    const l = this.levels[this.level];
    this.map.setPixelRatio(l.pixelRatio);
    this.onChange(l, this.level);
  }
}
