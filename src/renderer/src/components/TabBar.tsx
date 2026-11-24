import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { leafSession, leaves } from '../state/tree'
import { LOCAL_HOST, type SessionMeta, type Tab } from '@shared/types'

/** Pixels the pointer must travel before a press becomes a drag, so clicks stay clicks. */
const DRAG_SLOP = 5
/** How close to the strip's edge the pointer must be to scroll an overflowing strip. */
const EDGE = 28
const SLIDE = 'transform 170ms cubic-bezier(0.2, 0, 0, 1)'

/**
 * One tab drag, Chrome style: the pressed tab follows the pointer along the strip and the
 * tabs it passes slide aside to open its slot; on release it glides into that slot. Layout
 * is measured once at press time (offsetLeft inside the positioned `.tabs`, so scrolling
 * doesn't skew it) and every frame is a transform — nothing reflows and React doesn't
 * re-render while the pointer moves.
 */
type Drag = {
  id: string
  pointerId: number
  el: HTMLElement
  startX: number
  lastX: number
  scrollStart: number
  index: number
  ids: string[]
  lefts: number[]
  widths: number[]
  gap: number
  started: boolean
  offset: number
  target: number
  raf: number
}

/** Radius of the active tab's shoulders: the convex top corners and the concave flares at its foot. */
const CURVE = 8
/** Where the active tab's outline starts below the top of the bar. */
const OUTLINE_TOP = 6
/** How far along the tangent a corner's control points sit, as a share of CURVE (0.55 ~ a circle). */
const K = 0.55

/**
 * The selected tab's outline, Chrome style: one thin stroke that rises out of the bar's bottom
 * rule in a concave flare, climbs the tab's side, turns a convex corner across the top and comes
 * back down the same way -- each side an S of two cubics. The shape is filled with the page, so
 * the rule is erased under the tab and the tab reads as open onto the panes below it.
 *
 * Drawn in an SVG sized to the tab (measured, so the curves keep their radius at any width) and
 * CURVE wider on each side, which is where the flares sit; `.tabs` pads its ends to leave room.
 */
function TabOutline(): JSX.Element {
  const ref = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const host = ref.current?.parentElement
    if (!host) return
    const measure = (): void => {
      setSize((s) => (s && s.w === host.offsetWidth && s.h === host.offsetHeight ? s : { w: host.offsetWidth, h: host.offsetHeight }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])
  let edge = ''
  let fill = ''
  if (size) {
    const r = CURVE
    const x0 = r + 0.5              // the tab's left side, on a pixel centre so a 1px stroke stays crisp
    const x1 = r + size.w - 0.5     // its right side
    const top = OUTLINE_TOP + 0.5
    const base = size.h - 0.5       // the bar's bottom rule
    const c = r * K
    edge = [
      `M 0 ${base}`,
      `C ${c} ${base} ${x0} ${base - r + c} ${x0} ${base - r}`,          // left flare (concave)
      `L ${x0} ${top + r}`,
      `C ${x0} ${top + r - c} ${x0 + r - c} ${top} ${x0 + r} ${top}`,      // top-left corner (convex)
      `L ${x1 - r} ${top}`,
      `C ${x1 - r + c} ${top} ${x1} ${top + r - c} ${x1} ${top + r}`,      // top-right corner
      `L ${x1} ${base - r}`,
      `C ${x1} ${base - r + c} ${x1 + r - c} ${base} ${x1 + r} ${base}`    // right flare
    ].join(' ')
    fill = `${edge} L ${x1 + r} ${size.h} L 0 ${size.h} Z`
  }
  return (
    <svg ref={ref} className="tab-outline" width={size ? size.w + 2 * CURVE : 0} height={size?.h ?? 0} aria-hidden>
      {size && <path className="tab-outline-fill" d={fill} />}
      {size && <path className="tab-outline-edge" d={edge} />}
    </svg>
  )
}

/** The top rule: traffic-light inset, tabs, then a single new-session affordance. */
export default function TabBar(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const setOverlay = useStore((s) => s.setOverlay)
  const moveTab = useStore((s) => s.moveTab)

  const stripRef = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLDivElement>())
  const drag = useRef<Drag | null>(null)
  /** After a drop: where the dragged tab was drawn, so it can glide from there into its slot. */
  const settle = useRef<{ id: string; left: number } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  /** Lay out every tab for the drag's current pointer position. */
  const layout = useCallback((d: Drag): void => {
    const strip = stripRef.current
    if (!strip) return
    const i = d.index
    const n = d.ids.length
    const scrolled = strip.scrollLeft - d.scrollStart
    const min = d.lefts[0] - d.lefts[i]
    const max = d.lefts[n - 1] + d.widths[n - 1] - (d.lefts[i] + d.widths[i])
    d.offset = Math.max(min, Math.min(max, d.lastX - d.startX + scrolled))

    // Swap with a neighbour once the dragged tab's leading edge crosses its midpoint.
    // Measured against the original layout, so the decision is stable (no flicker).
    const left = d.lefts[i] + d.offset
    const right = left + d.widths[i]
    let target = i
    for (let j = i + 1; j < n && right > d.lefts[j] + d.widths[j] / 2; j++) target = j
    if (target === i) for (let j = i - 1; j >= 0 && left < d.lefts[j] + d.widths[j] / 2; j--) target = j
    d.target = target

    const step = d.widths[i] + d.gap
    d.ids.forEach((id, j) => {
      const el = els.current.get(id)
      if (!el) return
      if (j === i) { el.style.transform = `translateX(${d.offset}px)`; return }
      const shift = j > i && j <= target ? -step : j < i && j >= target ? step : 0
      el.style.transform = shift ? `translateX(${shift}px)` : ''
    })
  }, [])

  /** While dragging near an edge of an overflowing strip, keep scrolling it. */
  const autoscroll = useCallback((): void => {
    const d = drag.current
    const strip = stripRef.current
    if (!d || !d.started || !strip) return
    const r = strip.getBoundingClientRect()
    const v = d.lastX < r.left + EDGE ? -(r.left + EDGE - d.lastX) : d.lastX > r.right - EDGE ? d.lastX - (r.right - EDGE) : 0
    if (v && strip.scrollWidth > strip.clientWidth) {
      const before = strip.scrollLeft
      strip.scrollLeft += Math.round(v / 2) || Math.sign(v)
      if (strip.scrollLeft !== before) layout(d)
    }
    d.raf = requestAnimationFrame(autoscroll)
  }, [layout])

  const finish = useCallback((commit: boolean): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    cancelAnimationFrame(d.raf)
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    if (!d.started) return
    // On a reorder the neighbours are already drawn in their new slots, so they snap (the
    // DOM moves under them in the same frame); on a cancel they slide back. Either way the
    // layout effect below glides the dragged tab from where it was drawn into its slot.
    const moved = commit && d.target !== d.index
    for (const id of d.ids) {
      const el = els.current.get(id)
      if (!el) continue
      el.style.transition = moved || id === d.id ? 'none' : SLIDE
      el.style.transform = ''
    }
    settle.current = { id: d.id, left: d.lefts[d.index] + d.offset }
    setDraggingId(null)
    if (moved) moveTab(d.id, d.target)
  }, [moveTab])

  useLayoutEffect(() => {
    const s = settle.current
    if (!s || draggingId) return
    settle.current = null
    const el = els.current.get(s.id)
    if (el) {
      const delta = s.left - el.offsetLeft
      if (Math.abs(delta) > 0.5) {
        el.style.transform = `translateX(${delta}px)`
        void el.offsetWidth // commit the start frame before turning the transition on
        el.style.transition = SLIDE
        el.style.transform = ''
      }
    }
    // Hand transitions back to the stylesheet once the glide is over.
    setTimeout(() => {
      if (drag.current) return
      for (const x of els.current.values()) x.style.transition = ''
    }, 200)
  })

  // Escape cancels a drag; the tabs slide back to where they started.
  useEffect(() => {
    if (!draggingId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [draggingId, finish])

  // A drag must never outlive the component (HMR, tab bar unmount).
  useEffect(() => () => { const d = drag.current; if (d) cancelAnimationFrame(d.raf) }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, tabId: string): void => {
    if (e.button !== 0 || drag.current) return
    if ((e.target as HTMLElement).closest('.tab-close')) return
    const strip = stripRef.current
    if (!strip) return
    // Chrome selects on press, not release — the tab you grab is the tab you see.
    selectTab(tabId)
    const ids = useStore.getState().tabs.map((t) => t.id)
    const index = ids.indexOf(tabId)
    if (index < 0) return
    const lefts: number[] = []
    const widths: number[] = []
    for (const id of ids) {
      const el = els.current.get(id)
      lefts.push(el ? el.offsetLeft : 0)
      widths.push(el ? el.offsetWidth : 0)
    }
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0
    drag.current = {
      id: tabId, pointerId: e.pointerId, el: e.currentTarget, startX: e.clientX, lastX: e.clientX,
      scrollStart: strip.scrollLeft, index, ids, lefts, widths, gap,
      started: false, offset: 0, target: index, raf: 0
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    d.lastX = e.clientX
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < DRAG_SLOP) return
      d.started = true
      setDraggingId(d.id)
      for (const id of d.ids) {
        const el = els.current.get(id)
        if (el) el.style.transition = id === d.id ? 'none' : SLIDE
      }
      d.raf = requestAnimationFrame(autoscroll)
    }
    layout(d)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    finish(true)
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    finish(false)
  }

  const statusOf = (tab: Tab): string => {
    const metas = leaves(tab.root)
      .map((l) => { const sid = leafSession(l); return sid ? sessions[sid] : undefined })
      .filter(Boolean)
    if (metas.some((m) => m!.status === 'working')) return 'working'
    if (metas.some((m) => m!.status === 'handoff')) return 'handoff'
    if (metas.some((m) => m!.status === 'exited')) return 'exited'
    return 'idle'
  }

  const focusedMeta = (tab: Tab): SessionMeta | undefined => {
    const pane = leaves(tab.root).find((l) => l.id === tab.focusedPaneId) ?? leaves(tab.root)[0]
    const sid = pane ? leafSession(pane) : null
    return sid ? sessions[sid] : undefined
  }

  return (
    <div className="tabbar">
      <div className="tabbar-inset" />
      <div ref={stripRef} className={`tabs ${draggingId ? 'tabs-dragging' : ''}`}>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const meta = focusedMeta(tab)
          const provider = meta?.provider
          const remote = meta && meta.host && meta.host !== LOCAL_HOST ? meta : undefined
          const paneCount = leaves(tab.root).length
          const agentName = meta && meta.provider !== 'shell' ? meta.name : undefined
          return (
            <div
              key={tab.id}
              ref={(el) => { if (el) els.current.set(tab.id, el); else els.current.delete(tab.id) }}
              className={`tab ${active ? 'tab-active' : ''} ${draggingId === tab.id ? 'tab-dragging' : ''}`}
              onPointerDown={(e) => onPointerDown(e, tab.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onLostPointerCapture={onPointerCancel}
              onClick={() => selectTab(tab.id)}
              onDoubleClick={() => { selectTab(tab.id); setOverlay('rename') }}
              title={`${agentName ? `@${agentName} · ` : ''}${tab.title}${remote ? ` · on @${remote.host}` : ''}${paneCount > 1 ? ` · ${paneCount} panes` : ''}`}
            >
              {active && <TabOutline />}
              <span className={`dot dot-${statusOf(tab)}`} />
              {provider && <span className={`prov-dot prov-${provider}`} />}
              {agentName && <span className="agent-chip tab-agent mono">@{agentName}</span>}
              <span className="tab-title">{tab.title}</span>
              {remote && (
                <span
                  className={`tab-host mono link-${remote.remote?.link ?? 'attached'}`}
                  title={remote.remote?.link === 'lost' ? `Connection to @${remote.host} lost` : `Running on @${remote.host}`}
                >@{remote.host}</span>
              )}
              {paneCount > 1 && <span className="tab-panes mono">{paneCount}</span>}
              <button
                className="tab-close"
                title="Close tab (⌘W)"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button className="tab-new" title="New tab (⌘T)" onClick={() => void newTab()}>+</button>
      </div>
      <div className="tabbar-drag" />
    </div>
  )
}
