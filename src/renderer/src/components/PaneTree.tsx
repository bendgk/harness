import { useCallback, useRef } from 'react'
import Pane from './Pane'
import { useStore } from '../state/store'
import type { PaneNode } from '@shared/types'

interface Props {
  node: PaneNode
  focusedPaneId: string
}

/** Recursive layout: leaves are terminals, splits are flex rows/columns. */
export default function PaneTree({ node, focusedPaneId }: Props): JSX.Element {
  if (node.kind === 'leaf') {
    return <Pane paneId={node.id} content={node.content} focused={node.id === focusedPaneId} />
  }
  return (
    <div className={`split split-${node.dir}`}>
      {node.children.map((child, i) => (
        <SplitChild
          key={child.id}
          node={node}
          child={child}
          index={i}
          focusedPaneId={focusedPaneId}
        />
      ))}
    </div>
  )
}

function SplitChild({
  node, child, index, focusedPaneId
}: {
  node: Extract<PaneNode, { kind: 'split' }>
  child: PaneNode
  index: number
  focusedPaneId: string
}): JSX.Element {
  const size = node.sizes[index] ?? 100 / node.children.length
  return (
    <>
      {index > 0 && <Divider node={node} index={index} />}
      <div className="split-cell" style={{ flexBasis: `${size}%` }}>
        <PaneTree node={child} focusedPaneId={focusedPaneId} />
      </div>
    </>
  )
}

/** Drag to resize; the hairline thickens only while it is being used. */
function Divider({ node, index }: { node: Extract<PaneNode, { kind: 'split' }>; index: number }): JSX.Element {
  const resize = useStore((s) => s.resize)
  const ref = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const el = ref.current
      const container = el?.parentElement
      if (!container) return
      const horizontal = node.dir === 'row'
      const rect = container.getBoundingClientRect()
      const total = horizontal ? rect.width : rect.height
      const start = horizontal ? e.clientX : e.clientY
      const before = node.sizes[index - 1] ?? 50
      const after = node.sizes[index] ?? 50
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')

      const move = (ev: PointerEvent): void => {
        const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total * 100
        const min = 12
        const nextBefore = Math.max(min, Math.min(before + after - min, before + delta))
        const nextAfter = before + after - nextBefore
        const sizes = [...node.sizes]
        sizes[index - 1] = nextBefore
        sizes[index] = nextAfter
        resize(node.id, sizes)
      }
      const up = (): void => {
        el.classList.remove('dragging')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [node, index, resize]
  )

  return <div ref={ref} className={`divider divider-${node.dir}`} onPointerDown={onPointerDown} />
}
