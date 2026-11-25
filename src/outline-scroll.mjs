export function scrollOutlineRow(container, node, keepBottom = false) {
  if (!container?.clientHeight || !node) return;
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight), current = container.scrollTop;
  if (!maximum || keepBottom && current >= maximum - 1) return;
  const bounds = container.getBoundingClientRect(), row = node.getBoundingClientRect(), top = bounds.top + (container.clientTop || 0);
  if (row.top >= top && row.bottom <= top + container.clientHeight / 2) return;
  const next = Math.max(0, Math.min(maximum, current + row.top - top));
  if (Math.abs(next - current) > 1) container.scrollTop = next;
}
