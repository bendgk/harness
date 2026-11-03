import type { ITheme } from '@xterm/xterm'

/**
 * ANSI mapped onto printed-ink tones: inks and washes that belong on paper,
 * rather than the electric defaults that would break the matte surface.
 */
const DAY: ITheme = {
  background: '#f7f6f2',
  foreground: '#26241f',
  cursor: '#8a5a2b',
  cursorAccent: '#f7f6f2',
  selectionBackground: 'rgba(138, 90, 43, 0.20)',
  selectionForeground: '#1f1d19',
  black: '#3a372f',
  red: '#a3402f',
  green: '#3f6b46',
  yellow: '#8a6a1f',
  blue: '#39597f',
  magenta: '#7a4468',
  cyan: '#2f6a6a',
  white: '#d9d5ca',
  brightBlack: '#8c877c',
  brightRed: '#c0563f',
  brightGreen: '#528a58',
  brightYellow: '#a8862c',
  brightBlue: '#4d74a0',
  brightMagenta: '#9a5b84',
  brightCyan: '#3f8787',
  brightWhite: '#2a2824'
}

const NIGHT: ITheme = {
  background: '#16150f',
  foreground: '#e3dfd3',
  cursor: '#d19a5e',
  cursorAccent: '#16150f',
  selectionBackground: 'rgba(209, 154, 94, 0.26)',
  selectionForeground: '#f5f1e6',
  black: '#2a281f',
  red: '#d4705c',
  green: '#84b98c',
  yellow: '#d0aa60',
  blue: '#7d9fc4',
  magenta: '#bd8bab',
  cyan: '#6fb0ae',
  white: '#cfc9ba',
  brightBlack: '#6f6a60',
  brightRed: '#e08a74',
  brightGreen: '#9bd0a3',
  brightYellow: '#e6c37c',
  brightBlue: '#9bbde0',
  brightMagenta: '#d6a6c4',
  brightCyan: '#8ccac8',
  brightWhite: '#f5f1e6'
}

export function termTheme(mode: 'day' | 'night'): ITheme {
  return mode === 'night' ? NIGHT : DAY
}
