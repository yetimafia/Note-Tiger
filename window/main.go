// Note Tiger window: shows the control panel in a native Windows window (Microsoft Edge WebView2).
// Started by "Note Tiger.exe" (the tray launcher). Only one window is open at a time.
//
// Build: see installer/build.sh
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	shell32          = windows.NewLazySystemDLL("shell32.dll")
	procFindWindow   = user32.NewProc("FindWindowW")
	procShowWindow   = user32.NewProc("ShowWindow")
	procSetFg        = user32.NewProc("SetForegroundWindow")
	procIsIconic     = user32.NewProc("IsIconic")
	procShellExecute = shell32.NewProc("ShellExecuteW")
)

const title = "Note Tiger"

func openExternal(url string) {
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	u, _ := syscall.UTF16PtrFromString(url)
	procShellExecute.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(u)), 0, 0, 1)
}

// Read PANEL_PORT from app\.env next to this exe (default 3080).
func panelPort(base string) string {
	data, err := os.ReadFile(filepath.Join(base, "app", ".env"))
	if err == nil {
		if m := regexp.MustCompile(`(?m)^PANEL_PORT=(\d+)`).FindSubmatch(data); m != nil {
			return string(m[1])
		}
	}
	return "3080"
}

// Shown while the manager starts up; switches to the panel as soon as it answers.
const loadingPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;
background:#0d0f14;color:#e6e8ee;font:15px system-ui,"Segoe UI",sans-serif}
.t{font-size:28px;font-weight:800;margin-bottom:10px}.t span{color:#f5a524}
.s{color:#9aa3b5}.spin{width:28px;height:28px;border:3px solid #2a3140;border-top-color:#f5a524;border-radius:50%;
animation:r 1s linear infinite;margin:22px}@keyframes r{to{transform:rotate(360deg)}}
.err{display:none;color:#ffb3bb;max-width:460px;text-align:center;line-height:1.5}
</style></head><body><div class="t">🐯 Note <span>Tiger</span></div><div class="spin"></div>
<div class="s" id="s">Starting up…</div><div class="err" id="e">Note Tiger isn't responding. Right-click the tiger icon by the clock
and choose <b>Open log file</b> to see why, or quit and start Note Tiger again.</div>
<script>
const url = "%s";
let tries = 0;
async function check() {
  try { await fetch(url + "/api/status", { mode: "no-cors", cache: "no-store" }); location.replace(url + "/"); }
  catch { tries++; if (tries === 40) { document.getElementById("e").style.display = "block"; document.getElementById("s").style.display = "none"; }
    setTimeout(check, 750); }
}
check();
</script></body></html>`

func main() {
	exe, _ := os.Executable()
	base := filepath.Dir(exe)
	url := "http://localhost:" + panelPort(base)

	// Already open? Bring it to the front instead of opening a second window.
	name, _ := windows.UTF16PtrFromString("Local\\NoteTigerWindow")
	if _, err := windows.CreateMutex(nil, true, name); err == windows.ERROR_ALREADY_EXISTS {
		t, _ := syscall.UTF16PtrFromString(title)
		if hwnd, _, _ := procFindWindow.Call(0, uintptr(unsafe.Pointer(t))); hwnd != 0 {
			if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
				procShowWindow.Call(hwnd, 9) // SW_RESTORE
			}
			procSetFg.Call(hwnd)
		}
		return
	}

	dataPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "NoteTiger", "WebView2")
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  title,
			Width:  1180,
			Height: 840,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		// WebView2 isn't available (very rare on Windows 10/11): use the default browser instead.
		openExternal(url)
		return
	}
	defer w.Destroy()
	w.SetSize(900, 600, webview2.HintMin)

	// Links that leave the panel (invites, docs) open in the normal browser.
	_ = w.Bind("ntOpenExternal", func(u string) { openExternal(u) })
	w.Init(`window.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.href;
  if (href.startsWith('http') && !href.startsWith(location.origin)) { e.preventDefault(); window.ntOpenExternal(href); }
}, true);`)

	w.SetHtml(fmt.Sprintf(loadingPage, url))
	w.Run()
}
