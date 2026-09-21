import { BrowserWindow } from 'electron'
import { getDatabase } from './database'
import { escapeHtml } from './util/escapeHtml'

export interface LabelConfig {
  width: number // mm
  height: number // mm
  showPrice: boolean
  showName: boolean
  showBarcode: boolean
}

export const LabelService = {
  generateLabelHTML(product: { name: string; barcode: string; price: number }, config: LabelConfig): string {
    const labelWidth = 44
    const labelHeight = 31
    // JS-string-safe (not HTML): barcode is interpolated inside a <script>. JSON.stringify
    // quotes/escapes it; the <,> replacements prevent a crafted value from closing </script>.
    const safeBarcode = JSON.stringify(String(product.barcode ?? '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { 
      size: ${labelWidth}mm ${labelHeight}mm; 
      margin: 0; 
    }
    html, body { 
      width: ${labelWidth}mm; 
      height: ${labelHeight}mm; 
      overflow: hidden;
      background: white;
      font-family: 'Segoe UI', Arial, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 0; /* Remove all padding to allow edge-to-edge */
    }
    .name { 
      font-size: 16px; 
      font-weight: 1000; 
      text-align: center;
      width: 100%;
      line-height: 1.1;
      max-height: 2.2em;
      overflow: hidden;
      margin-bottom: 3mm;
      padding: 0 1mm;
      color: black;
    }
    .barcode-container { 
      width: 100%;
      height: 18mm; /* More vertical space */
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    #barcode {
      width: 100% !important; /* Force fill width */
      height: 100% !important; /* Force fill container height */
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.0/dist/JsBarcode.all.min.js"></script>
</head>
<body>
  ${config.showName ? `<div class="name">${escapeHtml(product.name)}</div>` : ''}
  <div class="barcode-container">
    <svg id="barcode" preserveAspectRatio="none"></svg>
  </div>
  
  <script>
    JsBarcode("#barcode", ${safeBarcode}, {
      format: "CODE128",
      width: 2.4, // Reduced from 4 to prevent clipping at 110% scale
      height: 110, 
      displayValue: false, 
      margin: 0
    });
  </script>
</body>
</html>
    `.trim()
  },

  async printLabel(product: { name: string; barcode: string; price: number }, config: LabelConfig, preview: boolean = false) {
    const win = new BrowserWindow({
      show: false,
      width: 600,
      height: 500,
      title: 'Barcode Label Preview',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    const html = this.generateLabelHTML(product, config)
    const previewHtml = preview
      ? html.replace('</body>', '<button onclick="window.print()" style="position:fixed; bottom:15px; right:15px; z-index:9999; padding:12px 20px; background: #2563eb; color:white; border:none; borderRadius:8px; cursor:pointer; font-weight:bold; font-size:16px;">Print Now</button></body>')
      : html

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(previewHtml)}`)
    await new Promise(resolve => setTimeout(resolve, 1500))

    if (preview) {
      win.show()
      win.focus()
      return
    }

    // SILENT PRINT - Configured for 44mm x 31mm
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
    const printerName = row ? JSON.parse(row.value).label : ''

    win.webContents.print({
      silent: true,
      printBackground: true,
      deviceName: printerName,
      margins: { marginType: 'none' },
      landscape: false,
      pageSize: {
        width: 44000,
        height: 31000
      },
      scaleFactor: 110
    }, (success, errorType) => {
      if (!success) console.error('Print failed:', errorType)
      win.close()
    })
  }
}
