// Note Tiger launcher: starts the bot in the background, shows a tray icon,
// opens the control panel, restarts the bot when settings change.
//
// Layout next to this exe:
//   runtime\node.exe
//   app\index.js (+ node_modules, .env, data\)
//
// Build (from Linux): x86_64-w64-mingw32-windres launcher.rc -O coff -o launcher.res
//   x86_64-w64-mingw32-gcc -O2 -municode -mwindows launcher.c launcher.res -o "Note Tiger.exe" -lshell32 -lwinhttp -luser32
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <wchar.h>

#define WM_TRAY (WM_APP + 1)
#define WM_CHILD_EXIT (WM_APP + 2)
#define ID_OPEN 1001
#define ID_RESTART 1002
#define ID_LOGS 1003
#define ID_FOLDER 1004
#define ID_QUIT 1005
#define RESTART_CODE 75
#define IDI_APP 1

static wchar_t g_base[MAX_PATH];   // folder containing this exe
static wchar_t g_appDir[MAX_PATH];
static wchar_t g_logPath[MAX_PATH];
static int g_port = 3080;
static HWND g_hwnd;
static NOTIFYICONDATAW g_nid;
static HANDLE g_child = NULL;
static BOOL g_quitting = FALSE;
static BOOL g_restarted = FALSE;      // tells the bot not to reopen the browser
static BOOL g_manualRestart = FALSE;  // tray menu "Restart bot" was clicked

static void openPanel(void) {
  wchar_t url[64];
  swprintf(url, 64, L"http://localhost:%d", g_port);
  ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
}

static void balloon(const wchar_t *title, const wchar_t *text) {
  g_nid.uFlags = NIF_INFO;
  wcsncpy(g_nid.szInfoTitle, title, 63);
  wcsncpy(g_nid.szInfo, text, 255);
  g_nid.dwInfoFlags = NIIF_INFO;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static void setTip(const wchar_t *tip) {
  g_nid.uFlags = NIF_TIP;
  wcsncpy(g_nid.szTip, tip, 127);
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

// Read PANEL_PORT from app\.env if present.
static void readPort(void) {
  wchar_t envPath[MAX_PATH];
  swprintf(envPath, MAX_PATH, L"%ls\\.env", g_appDir);
  HANDLE f = CreateFileW(envPath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return;
  char buf[8192] = {0};
  DWORD n = 0;
  ReadFile(f, buf, sizeof(buf) - 1, &n, NULL);
  CloseHandle(f);
  char *p = strstr(buf, "PANEL_PORT=");
  if (p && (p == buf || p[-1] == '\n')) {
    int port = atoi(p + 11);
    if (port > 0 && port < 65536) g_port = port;
  }
}

static DWORD WINAPI waitChild(LPVOID param) {
  HANDLE h = (HANDLE)param;
  WaitForSingleObject(h, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(h, &code);
  PostMessageW(g_hwnd, WM_CHILD_EXIT, (WPARAM)code, 0);
  return 0;
}

static BOOL startBot(void) {
  wchar_t node[MAX_PATH], cmd[MAX_PATH * 2];
  swprintf(node, MAX_PATH, L"%ls\\runtime\\node.exe", g_base);
  swprintf(cmd, MAX_PATH * 2, L"\"%ls\" index.js", node);

  CreateDirectoryW(g_appDir, NULL);
  wchar_t logDir[MAX_PATH];
  swprintf(logDir, MAX_PATH, L"%ls\\logs", g_appDir);
  CreateDirectoryW(logDir, NULL);

  SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
  HANDLE log = CreateFileW(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);

  // The bot opens the panel itself on first launch; after a restart it shouldn't.
  SetEnvironmentVariableW(L"NT_RESTARTED", g_restarted ? L"1" : NULL);
  SetEnvironmentVariableW(L"FORCE_COLOR", L"0");

  STARTUPINFOW si = { sizeof(si) };
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = log;
  si.hStdError = log;
  si.hStdInput = NULL;
  PROCESS_INFORMATION pi;
  BOOL ok = CreateProcessW(node, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, g_appDir, &si, &pi);
  if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
  if (!ok) {
    wchar_t msg[512];
    swprintf(msg, 512, L"Could not start the bot (error %lu).\nTry reinstalling Note Tiger.", GetLastError());
    MessageBoxW(NULL, msg, L"Note Tiger", MB_ICONERROR);
    return FALSE;
  }
  CloseHandle(pi.hThread);
  g_child = pi.hProcess;
  CreateThread(NULL, 0, waitChild, pi.hProcess, 0, NULL);
  setTip(L"Note Tiger: running");
  return TRUE;
}

// Ask the bot to shut down cleanly (saves any recording in progress), then force it if needed.
static void stopBot(DWORD waitMs) {
  if (!g_child) return;
  HINTERNET s = WinHttpOpen(L"NoteTiger", WINHTTP_ACCESS_TYPE_NO_PROXY, NULL, NULL, 0);
  if (s) {
    WinHttpSetTimeouts(s, 2000, 2000, 2000, 2000);
    HINTERNET c = WinHttpConnect(s, L"127.0.0.1", (INTERNET_PORT)g_port, 0);
    if (c) {
      HINTERNET r = WinHttpOpenRequest(c, L"POST", L"/api/stop", NULL, NULL, NULL, 0);
      if (r) {
        const wchar_t *hdr = L"Content-Type: application/json";
        WinHttpSendRequest(r, hdr, (DWORD)-1L, "{}", 2, 2, 0);
        WinHttpReceiveResponse(r, NULL);
        WinHttpCloseHandle(r);
      }
      WinHttpCloseHandle(c);
    }
    WinHttpCloseHandle(s);
  }
  if (WaitForSingleObject(g_child, waitMs) == WAIT_TIMEOUT) TerminateProcess(g_child, 0);
}

static void showMenu(void) {
  POINT pt;
  GetCursorPos(&pt);
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING | MF_DEFAULT, ID_OPEN, L"Open control panel");
  AppendMenuW(m, MF_STRING, ID_RESTART, g_child ? L"Restart bot" : L"Start bot");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, ID_LOGS, L"Open log file");
  AppendMenuW(m, MF_STRING, ID_FOLDER, L"Open data folder");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, ID_QUIT, L"Quit Note Tiger");
  SetForegroundWindow(g_hwnd);
  TrackPopupMenu(m, TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_hwnd, NULL);
  DestroyMenu(m);
}

static LRESULT CALLBACK wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_TRAY:
      if (LOWORD(lp) == WM_LBUTTONDBLCLK || LOWORD(lp) == NIN_SELECT) openPanel();
      else if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) showMenu();
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case ID_OPEN: openPanel(); break;
        case ID_RESTART:
          if (g_child) { g_manualRestart = TRUE; stopBot(20000); /* WM_CHILD_EXIT starts it again */ }
          else { g_restarted = TRUE; startBot(); }
          break;
        case ID_LOGS: ShellExecuteW(NULL, L"open", g_logPath, NULL, NULL, SW_SHOWNORMAL); break;
        case ID_FOLDER: {
          wchar_t d[MAX_PATH];
          swprintf(d, MAX_PATH, L"%ls\\data", g_appDir);
          CreateDirectoryW(d, NULL);
          ShellExecuteW(NULL, L"open", d, NULL, NULL, SW_SHOWNORMAL);
          break;
        }
        case ID_QUIT:
          g_quitting = TRUE;
          setTip(L"Note Tiger: stopping…");
          stopBot(30000);
          if (!g_child) DestroyWindow(h);
          break;
      }
      return 0;
    case WM_CHILD_EXIT: {
      DWORD code = (DWORD)wp;
      if (g_child) { CloseHandle(g_child); g_child = NULL; }
      if (g_quitting) { DestroyWindow(h); return 0; }
      if (code == RESTART_CODE || g_manualRestart) {
        g_manualRestart = FALSE;
        g_restarted = TRUE;
        readPort();
        startBot();
      } else if (code == 0) {
        // Stopped from the control panel.
        DestroyWindow(h);
      } else {
        setTip(L"Note Tiger: stopped (error)");
        balloon(L"Note Tiger stopped", L"The bot hit an error. Right-click the tiger icon → Open log file, or → Start bot.");
      }
      return 0;
    }
    case WM_DESTROY:
      Shell_NotifyIconW(NIM_DELETE, &g_nid);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdLine, int show) {
  (void)prev; (void)cmdLine; (void)show;

  GetModuleFileNameW(NULL, g_base, MAX_PATH);
  wchar_t *slash = wcsrchr(g_base, L'\\');
  if (slash) *slash = 0;
  swprintf(g_appDir, MAX_PATH, L"%ls\\app", g_base);
  swprintf(g_logPath, MAX_PATH, L"%ls\\logs\\note-tiger.log", g_appDir);
  readPort();

  // Already running? Just open the panel.
  CreateMutexW(NULL, TRUE, L"Local\\NoteTigerLauncher");
  if (GetLastError() == ERROR_ALREADY_EXISTS) { openPanel(); return 0; }

  WNDCLASSW wc = {0};
  wc.lpfnWndProc = wndProc;
  wc.hInstance = inst;
  wc.lpszClassName = L"NoteTigerTray";
  RegisterClassW(&wc);
  g_hwnd = CreateWindowW(wc.lpszClassName, L"Note Tiger", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, inst, NULL);

  g_nid.cbSize = sizeof(g_nid);
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  wcscpy(g_nid.szTip, L"Note Tiger: starting…");
  Shell_NotifyIconW(NIM_ADD, &g_nid);

  if (!startBot()) { Shell_NotifyIconW(NIM_DELETE, &g_nid); return 1; }
  balloon(L"Note Tiger is running", L"Double-click the tiger icon to open the control panel.");

  MSG m;
  while (GetMessageW(&m, NULL, 0, 0)) { TranslateMessage(&m); DispatchMessageW(&m); }
  return 0;
}
