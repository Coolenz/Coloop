import type { DesktopApi } from '../../shared/contracts'
import type { PrivateLoginApi, PrivateMemoryEntryApi } from '../../shared/credentials'
declare global {
  interface Window {
    coloop?: DesktopApi
    coloopPrivateLogin?: PrivateLoginApi
    coloopPrivateEntry?: PrivateMemoryEntryApi
  }
}
