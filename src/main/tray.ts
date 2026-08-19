import { Tray, nativeImage, screen } from 'electron'
import { join } from 'path'
import { surfacesDir, SurfaceManager } from './windows'
import { appIcon } from './paths'

// Menu-bar / system-tray brand mark. Click drops the companion panel under
// the icon (320pt, 4pt gap), mirroring MenuBarPanelManager. Deliberately NOT
// a template image — the mark stays coloured.

export function installTray(surfaces: SurfaceManager): Tray {
  const src = join(surfacesDir(), 'apprentice-mark.png')
  let img = nativeImage.createFromPath(src)
  if (img.isEmpty()) img = nativeImage.createFromPath(appIcon())
  img = img.resize({ width: 18, height: 18 })
  const tray = new Tray(img)
  tray.setToolTip('Apprentice')
  tray.on('click', (_e, bounds) => {
    const win = surfaces.get('menubar')
    if (win && win.isVisible()) {
      win.hide()
      return
    }
    const shown = surfaces.show('menubar')
    // Position: centered under the status item, 4pt gap (fall back to
    // top-right when bounds are empty, e.g. some Linux trays).
    const b = shown.getBounds()
    if (bounds && bounds.width > 0) {
      const x = Math.round(bounds.x + bounds.width / 2 - b.width / 2)
      const y = process.platform === 'darwin' ? bounds.y + bounds.height + 4 : bounds.y - b.height - 4
      const wa = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
      shown.setPosition(
        Math.max(wa.x, Math.min(x, wa.x + wa.width - b.width)),
        Math.max(wa.y, Math.min(y, wa.y + wa.height - b.height))
      )
    }
  })
  return tray
}
