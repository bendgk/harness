import type { PaperApi } from './index'

declare global {
  interface Window {
    paper: PaperApi
  }
}
