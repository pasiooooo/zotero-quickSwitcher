import { LayoutStore } from "../../src/layout.mjs";
export const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
export async function memoryStore(deviceID) {
  let text = null, fail = false;
  const values = { deviceID, clock: 0 };
  const io = { read: async () => text, write: async value => { if (fail) throw new Error("disk error"); text = value; } };
  const prefs = { get: key => values[key], set: (key, value) => { values[key] = value; } };
  const store = await new LayoutStore({ prefs, io }).init();
  return { store, prefs, io, fail: value => { fail = value; } };
}
export const placement = parent => ({ parentCollectionKey: parent, anchorCollectionKey: null, anchorSide: "after", order: 1 });
