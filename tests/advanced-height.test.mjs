import test from "node:test";
import assert from "node:assert/strict";
import { Launcher } from "../src/launcher.mjs";

function fixture(bottoms) {
  const values = new Map(), view = Object.create(Launcher.prototype);
  view.isOpen = true;
  view.advanced = { hidden: false, scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }), style: {
    setProperty: (name, value) => values.set(name, value), removeProperty: name => values.delete(name),
  } };
  view.rows = bottoms.map(bottom => ({ getClientRects: () => [1], getBoundingClientRect: () => ({ bottom }) }));
  view.widget = { querySelectorAll: () => view.rows };
  view.win = { getComputedStyle: () => ({ borderBottomWidth: "1px" }) };
  return { view, values };
}

test("advanced conditions fit up to five actual rows and cap at the fifth bottom", () => {
  const { view, values } = fixture([170, 203, 236, 300, 333]);
  view.measureAdvancedHeight(); assert.equal(values.size, 0);
  view.rows.push({ getClientRects: () => [1], getBoundingClientRect: () => ({ bottom: 366 }) });
  view.measureAdvancedHeight(); assert.equal(values.get("--qs-advanced-height"), "234px");
  view.advanced.scrollTop = 40;
  for (const row of view.rows) { const bottom = row.getBoundingClientRect().bottom; row.getBoundingClientRect = () => ({ bottom: bottom - 40 }); }
  view.measureAdvancedHeight(); assert.equal(values.get("--qs-advanced-height"), "234px", "Scrolling does not change the five-row limit");
  view.rows.splice(4); view.measureAdvancedHeight(); assert.equal(values.size, 0, "Removing conditions restores natural height");
});

test("advanced height observers coalesce changes and are removed on close", () => {
  const { view, values } = fixture([170, 210, 250, 290, 330, 370]);
  const observers = [], frames = new Map(); let nextFrame = 0;
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  }
  Object.assign(view.win, { MutationObserver: Observer, ResizeObserver: Observer,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  view.watchAdvancedHeight(); observers[0].callback(); observers[1].callback();
  assert.equal(frames.size, 1, "DOM and resize changes share one measurement frame");
  frames.get(1)(); frames.delete(1); assert.equal(values.get("--qs-advanced-height"), "231px");
  view.queueAdvancedHeight(); view.stopAdvancedHeight();
  assert.equal(frames.size, 0); assert.equal(values.size, 0); assert.ok(observers.every(observer => observer.disconnected));
  view.advanced.hidden = true; view.watchAdvancedHeight(); assert.equal(observers.length, 2);
});
