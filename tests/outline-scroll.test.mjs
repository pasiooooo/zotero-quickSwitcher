import test from "node:test";
import assert from "node:assert/strict";
import { scrollOutlineRow } from "../src/outline-scroll.mjs";

function viewport({ scrollTop = 500, offset = 50, height = 32, scrollHeight = 2000 } = {}) {
  let current = scrollTop;
  const writes = [], contentTop = scrollTop + offset;
  const container = { clientTop: 2, clientHeight: 400, scrollHeight, getBoundingClientRect: () => ({ top: 100 }),
    get scrollTop() { return current; }, set scrollTop(value) { writes.push(value); current = value; } };
  const node = { getBoundingClientRect: () => ({ top: 102 + contentTop - current, bottom: 102 + contentTop - current + height }) };
  return { container, node, writes };
}

test("headings inside the upper-half zone do not move the outline", () => {
  for (const offset of [0, 50, 168]) {
    const { container, node, writes } = viewport({ offset });
    scrollOutlineRow(container, node); assert.deepEqual(writes, []);
  }
});

test("crossing the zone bottom makes one immediate jump to its top, then stays put", () => {
  const { container, node, writes } = viewport({ offset: 169 });
  scrollOutlineRow(container, node); assert.deepEqual(writes, [669]);
  assert.equal(node.getBoundingClientRect().top, 102);
  scrollOutlineRow(container, node); assert.deepEqual(writes, [669]);
});

test("an above-zone heading moves directly to the zone top", () => {
  const { container, node, writes } = viewport({ offset: -30 });
  scrollOutlineRow(container, node); assert.deepEqual(writes, [470]);
});

test("automatic following stays at the bottom even when the active heading changes", () => {
  for (const scrollTop of [1600, 1599.5]) {
    const { container, node, writes } = viewport({ scrollTop, offset: -900 });
    scrollOutlineRow(container, node, true); assert.deepEqual(writes, []);
    scrollOutlineRow(container, node, false); assert.equal(writes.length, 1);
  }
});

test("short lists, tall titles at the zone top and clamped end positions do not cause extra scrolling", () => {
  for (const options of [{ scrollTop: 0, offset: 0, scrollHeight: 300 }, { offset: 0, height: 300 }, { scrollTop: 1600, offset: 600 }]) {
    const { container, node, writes } = viewport(options);
    scrollOutlineRow(container, node); assert.deepEqual(writes, []);
  }
});
