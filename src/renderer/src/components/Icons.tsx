/**
 * Pane-chrome icons. Drawn rather than borrowed from a font so each one states
 * plainly what it does: the splits show where the new pane appears, and
 * "contents" shows something being exchanged inside a frame — a different idea
 * from splitting, and it should not look like one.
 */
const base = {
  width: 13,
  height: 13,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export function SplitRightIcon(): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
      <line x1="8" y1="2.8" x2="8" y2="13.2" />
      <line x1="10.2" y1="8" x2="12.4" y2="8" strokeWidth="1.1" opacity="0.55" />
    </svg>
  )
}

export function SplitDownIcon(): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
      <line x1="1.8" y1="8" x2="14.2" y2="8" />
      <line x1="8" y1="10.2" x2="8" y2="12.2" strokeWidth="1.1" opacity="0.55" />
    </svg>
  )
}

/** Contents: what sits inside the frame is swapped for something else. */
export function ContentsIcon(): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
      <path d="M5 7.1h6l-1.7-1.7" />
      <path d="M11 9.4H5l1.7 1.7" />
    </svg>
  )
}

export function CloseIcon(): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <line x1="4.2" y1="4.2" x2="11.8" y2="11.8" />
      <line x1="11.8" y1="4.2" x2="4.2" y2="11.8" />
    </svg>
  )
}

export function FolderIcon(): JSX.Element {
  return (
    <svg {...base} width="11" height="11" aria-hidden="true">
      <path d="M2 4.6a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  )
}
