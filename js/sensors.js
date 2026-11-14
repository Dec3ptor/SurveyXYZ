// Browser sensor plumbing: geolocation, accelerometer (steps / stillness),
// compass, and screen wake lock. Feeds the FusionFilter.
import { StepDetector } from './fusion.js';

export class Sensors {
  constructor(filter, { onFix, onError, onStep }) {
    this.filter = filter;
    this.onFix = onFix; this.onError = onError; this.onStep = onStep || (() => {});
    this.steps = new StepDetector();
    this.compass = null;
    this.motionOk = false;
    this.watchId = null;
    this.wake = null;
    this.wantWake = false;
    this.lastT = 0;
    this._motion = (e) => this.handleMotion(e);
    this._orient = (e) => this.handleOrientation(e);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantWake) this.keepAwake(true);
    });
  }

  startGps() {
    if (this.watchId != null || !navigator.geolocation) {
      if (!navigator.geolocation) this.onError({ message: 'This browser has no location support' });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handlePosition(pos),
      (err) => this.onError(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  handlePosition(pos) {
    const c = pos.coords;
    // Some browsers hand out odd timestamps; fall back to the device clock.
    let t = pos.timestamp;
    const now = Date.now();
    if (!Number.isFinite(t) || Math.abs(t - now) > 60000) t = now;
    if (t <= this.lastT) return;
    this.lastT = t;
    const perf = performance.now();
    const hasMotion = this.motionOk && perf - this.steps.lastSample < 3000;
    this.filter.setMotion(hasMotion, hasMotion ? this.steps.moving(perf) : true);
    const fix = {
      t, lat: c.latitude, lon: c.longitude, acc: c.accuracy,
      alt: c.altitude, speed: c.speed, heading: c.heading,
    };
    const est = this.filter.onGps(fix);
    this.onFix(fix, est, { hasMotion, compass: this.compass });
  }

  /** Must be called from a user gesture (iOS asks for permission here). */
  async startMotion() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        await DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch { return false; }
    window.removeEventListener('devicemotion', this._motion);
    window.addEventListener('devicemotion', this._motion);
    for (const ev of ['deviceorientationabsolute', 'deviceorientation']) {
      window.removeEventListener(ev, this._orient);
      window.addEventListener(ev, this._orient);
    }
    return true;
  }

  handleMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    this.motionOk = true;
    const t = performance.now();
    if (this.steps.sample(Math.hypot(a.x, a.y, a.z), t)) {
      this.filter.onStep();
      this.onStep();
    }
  }

  handleOrientation(e) {
    let h = null;
    if (Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading; // iOS
    else if ((e.absolute || e.type === 'deviceorientationabsolute') && Number.isFinite(e.alpha)) h = (360 - e.alpha) % 360;
    if (h == null) return;
    this.compass = h;
    this.filter.setCompass(h);
  }

  /** Keep the screen on: browsers stop delivering GPS when the screen locks. */
  async keepAwake(on) {
    this.wantWake = on;
    try {
      if (on && 'wakeLock' in navigator) {
        if (!this.wake || this.wake.released) this.wake = await navigator.wakeLock.request('screen');
      } else if (!on && this.wake) { await this.wake.release(); this.wake = null; }
    } catch { /* denied or unsupported: user must keep the screen on manually */ }
    return !!this.wake && !this.wake.released;
  }
}
