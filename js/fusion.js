// GPS + motion-sensor fusion. Pure logic, no DOM (unit-tested in Node).
//
// A position Kalman filter working in local metres:
//  - Each detected footstep moves the estimate one step-length along the
//    travel heading (compass + an offset learned against GPS course, so it
//    does not matter how the phone is carried as long as it is carried
//    consistently). This is pedestrian dead reckoning (PDR).
//  - Each GPS fix corrects the estimate, weighted by its reported accuracy.
//  - When the accelerometer says the device is still, the estimate is allowed
//    to move only very slowly, so GPS "wander" while you stand taking a
//    reading is averaged out instead of drawn as movement.
//  - A fix that disagrees wildly with where you could plausibly be is treated
//    as a jump and ignored; if GPS keeps insisting, the filter re-locks to it.
// The raw fix is always returned alongside so nothing is lost.
import { LocalFrame, angDiff, bearing, haversine } from './geo.js';

const GATE = 9.21; // chi-square(2) 99%

export class FusionFilter {
  constructor(opts = {}) {
    this.o = { mode: 'smart', maxAcc: 25, minR: 3, maxSpeed: 3, stepLen: 0.72, relockAfter: 5, ...opts };
    this.reset();
  }

  reset() {
    this.frame = null;
    this.x = 0; this.y = 0; this.P = 0;
    this.tLast = 0;
    this.gateCount = 0;
    this.hasMotion = false; // accelerometer available?
    this.moving = true;
    this.compass = null; // latest device compass heading
    this.hdgOffset = null; // travel course minus compass, learned
    this.course = null; // latest GPS course over ground
    this.courseT = 0;
    this.stepLen = this.o.stepLen;
    this.stepsSinceFix = 0;
    this.stepsTotal = 0;
    this.anchor = null; // {lat, lon, steps} for course / step-length learning
    this.calDist = 0; this.calSteps = 0;
  }

  get ready() { return !!this.frame; }
  get position() {
    if (!this.frame) return null;
    const [lat, lon] = this.frame.toLL(this.x, this.y);
    return { lat, lon, sigma: Math.sqrt(this.P) };
  }
  /** Best estimate of direction of travel, degrees, or null. */
  get travelHeading() {
    if (this.compass != null && this.hdgOffset != null) return (this.compass + this.hdgOffset + 360) % 360;
    return this.course;
  }

  setMotion(hasMotion, moving) { this.hasMotion = hasMotion; this.moving = moving; }
  setCompass(deg) { this.compass = deg; }

  /** Call once per detected footstep. */
  onStep() {
    this.stepsTotal++;
    this.stepsSinceFix++;
    if (!this.frame || this.o.mode !== 'smart') return;
    const h = this.travelHeading;
    const L = this.stepLen;
    if (h == null) { this.P += L * L; return; }
    const r = (h * Math.PI) / 180;
    this.x += L * Math.sin(r);
    this.y += L * Math.cos(r);
    this.P += (0.35 * L) ** 2;
  }

  /**
   * Feed a GPS fix {t(ms), lat, lon, acc(m), speed?, heading?}.
   * Returns {lat, lon, used, why, moving, sigma}: the filtered position after
   * this fix. used=false means the fix itself was not trusted.
   */
  onGps(fix) {
    const o = this.o;
    const raw = { lat: fix.lat, lon: fix.lon, used: true, why: '', moving: this.moving, sigma: fix.acc };
    if (o.mode === 'raw') return raw;
    const acc = Number.isFinite(fix.acc) ? fix.acc : 50;
    const R = Math.max(acc, o.minR) ** 2;

    if (!this.frame) {
      if (acc > o.maxAcc) return { ...raw, used: false, why: 'accuracy' };
      this.frame = new LocalFrame(fix.lat, fix.lon);
      this.x = 0; this.y = 0; this.P = R; this.tLast = fix.t;
      this.anchor = { lat: fix.lat, lon: fix.lon, steps: this.stepsTotal };
      return raw;
    }

    const dt = Math.max(0, (fix.t - this.tLast) / 1000);
    this.tLast = fix.t;
    const smart = o.mode === 'smart' && this.hasMotion;
    const gpsSpeed = Number.isFinite(fix.speed) ? fix.speed : null;
    let moving, q;
    if (smart) {
      moving = this.moving;
      // Still: hold. Walking with steps counted: PDR already moved us, small slack.
      // Moving without steps (vehicle, odd carry): let GPS lead.
      q = !moving ? 0.03 : this.stepsSinceFix > 0 ? 0.4 : 1.5;
    } else {
      moving = gpsSpeed == null ? true : gpsSpeed > 0.3;
      q = gpsSpeed == null ? 1.2 : Math.min(o.maxSpeed, Math.max(0.15, gpsSpeed));
    }
    this.P += q * q * dt;
    this.stepsSinceFix = 0;

    const out = () => {
      const [lat, lon] = this.frame.toLL(this.x, this.y);
      return { lat, lon, used: true, why: '', moving, sigma: Math.sqrt(this.P) };
    };

    if (acc > o.maxAcc) return { ...out(), used: false, why: 'accuracy' };

    const [zx, zy] = this.frame.toXY(fix.lat, fix.lon);
    const dx = zx - this.x, dy = zy - this.y;
    const S = this.P + R;
    if ((dx * dx + dy * dy) / S > GATE) {
      if (++this.gateCount >= o.relockAfter) {
        // GPS has disagreed consistently: believe it and start again from here.
        this.x = zx; this.y = zy; this.P = R; this.gateCount = 0;
        this.anchor = { lat: fix.lat, lon: fix.lon, steps: this.stepsTotal };
        return { ...out(), why: 'relock' };
      }
      return { ...out(), used: false, why: 'jump' };
    }
    this.gateCount = 0;
    const K = this.P / S;
    this.x += K * dx; this.y += K * dy; this.P *= 1 - K;

    this.learn(fix, acc, gpsSpeed);
    return out();
  }

  /** Learn compass→course offset and step length from good GPS while walking. */
  learn(fix, acc, gpsSpeed) {
    if (acc > 12) return;
    let course = null;
    if (gpsSpeed != null && gpsSpeed > 0.7 && Number.isFinite(fix.heading)) course = fix.heading;
    const a = this.anchor;
    if (a) {
      const d = haversine(a.lat, a.lon, fix.lat, fix.lon);
      if (d >= Math.max(10, 2 * acc)) {
        if (course == null) course = bearing(a.lat, a.lon, fix.lat, fix.lon);
        const steps = this.stepsTotal - a.steps;
        if (steps > 0) {
          this.calDist += d; this.calSteps += steps;
          if (this.calDist >= 30 && this.calSteps >= 20) {
            const est = this.calDist / this.calSteps;
            if (est > 0.4 && est < 1.1) this.stepLen = 0.8 * this.stepLen + 0.2 * est;
            this.calDist = 0; this.calSteps = 0;
          }
        }
        this.anchor = { lat: fix.lat, lon: fix.lon, steps: this.stepsTotal };
      }
    } else this.anchor = { lat: fix.lat, lon: fix.lon, steps: this.stepsTotal };

    if (course == null) return;
    this.course = course; this.courseT = fix.t;
    if (this.compass != null && this.moving) {
      const d = angDiff(course, this.compass);
      this.hdgOffset = this.hdgOffset == null ? d : this.hdgOffset + 0.15 * angDiff(d, this.hdgOffset);
    }
  }
}

/** Footstep + stillness detector fed with accelerometer magnitude samples (m/s²). */
export class StepDetector {
  constructor() {
    this.g = 9.81; this.hp = 0; this.varE = 0;
    this.armed = true; this.lastStep = 0; this.lastSample = 0; this.n = 0;
  }
  /** Returns true if this sample completes a step. */
  sample(mag, t) {
    this.n++;
    this.lastSample = t;
    this.g += 0.02 * (mag - this.g);
    this.hp += 0.3 * (mag - this.g - this.hp);
    this.varE += 0.02 * (this.hp * this.hp - this.varE);
    if (this.armed && this.hp > 1.0 && t - this.lastStep > 280) {
      this.armed = false; this.lastStep = t;
      return true;
    }
    if (this.hp < 0.3) this.armed = true;
    return false;
  }
  moving(t) { return t - this.lastStep < 2000 || this.varE > 0.6; }
}
