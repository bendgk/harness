import { useMemo } from 'react'
import { useStore } from '../state/store'
import { layoutRects, leaves, movePane } from '../state/tree'
import { paneWidget } from '../widgets/panes'
import type { PaneNode, SessionMeta } from '@shared/types'

type Leaf = Extract<PaneNode, { kind: 'leaf' }>

function labelFor(node: Leaf, sessions: Record<string, SessionMeta>): string {
  if (node.content.type === 'widget') return paneWidget(node.content.widget)?.name ?? 'Widget'
  const sid = node.content.sessionId
  return sid ? sessions[sid]?.title ?? 'Session' : 'Empty'
}

/**
 * A live wireframe of what the layout will be once the pane is dropped.
 *
 * Rather than washing half of the pane under the cursor, this runs the real
 * move against the real tree and draws the result — so it shows the things a
 * simple highlight cannot: siblings resizing to make room, the gap left behind
 * closing up, and a centre drop swapping two panes rather than inserting one.
 */
export default function DragPreview(): JSX.Element | null {
  const dragging = useStore((s) => s.dragging)
  const dragOver = useStore((s) => s.dragOver)
  const tab = useStore((s) => s.activeTab())
  const sessions = useStore((s) => s.sessions)

  const preview = useMemo(() => {
    if (!dragging || !dragOver || !tab) return null

    // Dragging back over where it started is a real answer, not the absence of
    // one: the layout stays as it is. Blanking the preview there would make the
    // canvas flicker every time you passed over home on the way somewhere else.
    const overSelf = dragOver.paneId === dragging
    const root = overSelf ? tab.root : movePane(tab.root, dragging, dragOver.paneId, dragOver.zone)
    const unchanged = root === tab.root

    const byId = new Map(leaves(root).map((l) => [l.id, l]))
    // On a swap the dragged content ends up in the pane it was dropped on;
    // on an edge dock the pane itself moves and keeps its id. A swap moves two
    // panes, so the pane giving up its place is marked as well.
    const swap = !unchanged && dragOver.zone === 'center'
    const highlight = swap ? dragOver.paneId : dragging
    const counterpart = swap ? dragging : null
    const action = unchanged ? 'stays' : swap ? '⇄ swap' : 'here'
    return { rects: layoutRects(root), byId, highlight, counterpart, unchanged, action }
  }, [dragging, dragOver, tab])

  if (!preview) return null

  return (
    <div className="drag-preview" aria-hidden="true">
      {preview.rects.map((r) => {
        const node = preview.byId.get(r.id)
        if (!node) return null
        const moved = r.id === preview.highlight
        const counterpart = r.id === preview.counterpart
        return (
          <div
            key={r.id}
            className="dp-slot"
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`
            }}
          >
            <div
              className={
                `dp-box ${moved ? 'dp-moved' : ''} ${counterpart ? 'dp-counterpart' : ''}` +
                (preview.unchanged ? ' dp-still' : '')
              }
            >
              <span className="dp-label">{labelFor(node, sessions)}</span>
              {(moved || counterpart) && <span className="dp-action">{preview.action}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
