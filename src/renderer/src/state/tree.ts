import type { DropZone, PaneContent, PaneNode } from '@shared/types'

export const uid = (): string => Math.random().toString(36).slice(2, 10)

export function leaf(content: PaneContent = { type: 'terminal', sessionId: null }): PaneNode {
  return { kind: 'leaf', id: uid(), content }
}

export function terminalLeaf(sessionId: string | null = null): PaneNode {
  return leaf({ type: 'terminal', sessionId })
}

export function widgetLeaf(widget: string, props?: Record<string, unknown>): PaneNode {
  return leaf({ type: 'widget', widget, props })
}

type Leaf = Extract<PaneNode, { kind: 'leaf' }>

export function leaves(node: PaneNode): Leaf[] {
  return node.kind === 'leaf' ? [node] : node.children.flatMap(leaves)
}

export function findLeaf(node: PaneNode, id: string): Leaf | undefined {
  return leaves(node).find((l) => l.id === id)
}

/** The session a leaf is running, if it is a terminal at all. */
export function leafSession(node: Leaf): string | null {
  return node.content?.type === 'terminal' ? node.content.sessionId : null
}

/** Layouts written before panes could hold widgets store a bare `sessionId`. */
export function migrateNode(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') {
    if (node.content) return node
    return { kind: 'leaf', id: node.id, content: { type: 'terminal', sessionId: node.sessionId ?? null } }
  }
  return { ...node, children: node.children.map(migrateNode) }
}

/** Replace a leaf with a split containing it plus a new pane. */
export function splitPane(root: PaneNode, paneId: string, dir: 'row' | 'col', newLeaf: PaneNode): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node
      return { kind: 'split', id: uid(), dir, sizes: [50, 50], children: [node, newLeaf] }
    }
    // Growing an existing split in the same direction keeps the tree flat,
    // so three panes side by side stay evenly sized instead of nesting.
    if (node.dir === dir && node.children.some((c) => c.kind === 'leaf' && c.id === paneId)) {
      const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === paneId)
      const children = [...node.children.slice(0, idx + 1), newLeaf, ...node.children.slice(idx + 1)]
      const even = 100 / children.length
      return { ...node, children, sizes: children.map(() => even) }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/** Remove a leaf, collapsing any split left with a single child. */
export function removePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === 'leaf') return root.id === paneId ? null : root
  const kept: PaneNode[] = []
  const keptSizes: number[] = []
  root.children.forEach((child, i) => {
    const next = removePane(child, paneId)
    if (next) {
      kept.push(next)
      keptSizes.push(root.sizes[i] ?? 100 / root.children.length)
    }
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0]
  const total = keptSizes.reduce((a, b) => a + b, 0) || 100
  return { ...root, children: kept, sizes: keptSizes.map((s) => (s / total) * 100) }
}

export function setPaneContent(root: PaneNode, paneId: string, content: PaneContent): PaneNode {
  const walk = (node: PaneNode): PaneNode =>
    node.kind === 'leaf'
      ? node.id === paneId ? { ...node, content } : node
      : { ...node, children: node.children.map(walk) }
  return walk(root)
}

export function setPaneSession(root: PaneNode, paneId: string, sessionId: string | null): PaneNode {
  return setPaneContent(root, paneId, { type: 'terminal', sessionId })
}

/** Merge props into a widget pane — how widgets persist their own state. */
export function patchWidgetProps(root: PaneNode, paneId: string, props: Record<string, unknown>): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId || node.content.type !== 'widget') return node
      return { ...node, content: { ...node.content, props: { ...node.content.props, ...props } } }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

export function resizeSplit(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  const walk = (node: PaneNode): PaneNode =>
    node.kind === 'leaf'
      ? node
      : node.id === splitId
        ? { ...node, sizes }
        : { ...node, children: node.children.map(walk) }
  return walk(root)
}

/** A pane's rectangle as fractions of the canvas, for previews and hit tests. */
export interface PaneRect { id: string; x: number; y: number; w: number; h: number }

/**
 * Flatten a tree into geometry. This is the same arithmetic the flex layout
 * performs, so a preview drawn from these rectangles matches what the panes
 * will actually do — including siblings resizing to make room.
 */
export function layoutRects(node: PaneNode, x = 0, y = 0, w = 1, h = 1): PaneRect[] {
  if (node.kind === 'leaf') return [{ id: node.id, x, y, w, h }]
  const even = 100 / node.children.length
  const total = node.sizes.reduce((a, b) => a + b, 0) || 100
  const out: PaneRect[] = []
  let cursor = node.dir === 'row' ? x : y
  node.children.forEach((child, i) => {
    const frac = (node.sizes[i] ?? even) / total
    if (node.dir === 'row') {
      const cw = w * frac
      out.push(...layoutRects(child, cursor, y, cw, h))
      cursor += cw
    } else {
      const ch = h * frac
      out.push(...layoutRects(child, x, cursor, w, ch))
      cursor += ch
    }
  })
  return out
}

/** Cycle focus through panes in visual order. */
export function neighbourLeaf(root: PaneNode, paneId: string, delta: number): string | undefined {
  const all = leaves(root)
  const i = all.findIndex((l) => l.id === paneId)
  if (i < 0 || all.length < 2) return undefined
  return all[(i + delta + all.length) % all.length].id
}

/** Drop a pane onto the edge of another: insert beside it, splitting as needed. */
function insertBeside(root: PaneNode, targetId: string, moved: PaneNode, zone: DropZone): PaneNode {
  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const before = zone === 'left' || zone === 'top'

  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== targetId) return node
      const children = before ? [moved, node] : [node, moved]
      return { kind: 'split', id: uid(), dir, sizes: [50, 50], children }
    }
    if (node.dir === dir && node.children.some((c) => c.kind === 'leaf' && c.id === targetId)) {
      const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId)
      const at = before ? idx : idx + 1
      const children = [...node.children.slice(0, at), moved, ...node.children.slice(at)]
      const even = 100 / children.length
      return { ...node, children, sizes: children.map(() => even) }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/**
 * Move a pane onto another. An edge zone docks it alongside the target;
 * the centre swaps the two panes' contents, which is the quickest way to
 * rearrange a layout you already like.
 */
export function movePane(root: PaneNode, sourceId: string, targetId: string, zone: DropZone): PaneNode {
  if (sourceId === targetId) return root
  const source = findLeaf(root, sourceId)
  const target = findLeaf(root, targetId)
  if (!source || !target) return root

  if (zone === 'center') {
    const walk = (node: PaneNode): PaneNode => {
      if (node.kind === 'leaf') {
        if (node.id === sourceId) return { ...node, content: target.content }
        if (node.id === targetId) return { ...node, content: source.content }
        return node
      }
      return { ...node, children: node.children.map(walk) }
    }
    return walk(root)
  }

  const without = removePane(root, sourceId)
  if (!without) return root
  // The target may have been collapsed away when its sibling was removed.
  if (!findLeaf(without, targetId)) return root
  return insertBeside(without, targetId, { ...source }, zone)
}
