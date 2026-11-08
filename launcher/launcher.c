// Note Tiger launcher ("Note Tiger.exe"): starts the manager (server.js) in the background,
// opens the Note Tiger window, and keeps a tray icon by the clock so you know it's running.
//
// Layout next to this exe:
//   Note Tiger Window.exe   the app window (WebView2)
//   runtime\node.exe
//   app\server.js (+ index.js, node_modules, .env, data\)
//
// Build: see installer/build.sh
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <wchar.h>
#include <string.h>
#include <stdlib.h>

#define WM_TRAY (WM_APP + 1)
#define WM_CHILD_EXIT (WM_APP + 2)
#define ID_OPEN 1001
#define ID_BOT 1002
#define ID_LOGS 1003
#define ID_FOLDER 1004
#define ID_QUIT 1005
#define ID_RESTART 1006
#define RESTART_CODE 75
#define PORT_BUSY_CODE 3
#define IDI_APP 1

static wchar_t g_base[MAX_PATH];
static wchar_t g_appDir[MAX_PATH];
static wchar_t g_logPath[MAX_PATH];
static int g_port = 3080;
static HWND g_hwnd;
static NOTIFYICONDATAW g_nid;
static HANDLE g_child = NULL;
static BOOL g_quitting = FALSE;
static BOOL g_restartRequested = FALSE;
static BOOL g_restarted = FALSE;
static DWORD g_crashTimes[3] = {0};

static void openWindow(void) {
  wchar_t win[MAX_PATH];
  swprintf(win, MAX_PATH, L"%ls\\Note Tiger Window.exe", g_base);
  if ((INT_PTR)ShellExecuteW(NULL, L"open", win, NULL, g_base, SW_SHOWNORMAL) <= 32) {
    wchar_t url[64];
    swprintf(url, 64, L"http://localhost:%d", g_port);
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
  }
}

static void closeWindow(void) {
  HWND w = FindWindowW(NULL, L"Note Tiger");
  if (w) PostMessageW(w, WM_CLOSE, 0, 0);
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

// Small HTTP helper for talking to the manager. Returns bytes read into out (or -1).
static int http(const wchar_t *method, const wchar_t *path, char *out, int outLen, DWORD timeoutMs) {
  int total = -1;
  HINTERNET s = WinHttpOpen(L"NoteTiger", WINHTTP_ACCESS_TYPE_NO_PROXY, NULL, NULL, 0);
  if (!s) return -1;
  WinHttpSetTimeouts(s, timeoutMs, timeoutMs, timeoutMs, timeoutMs);
  HINTERNET c = WinHttpConnect(s, L"127.0.0.1", (INTERNET_PORT)g_port, 0);
  if (c) {
    HINTERNET r = WinHttpOpenRequest(c, method, path, NULL, NULL, NULL, 0);
    if (r) {
      BOOL post = wcscmp(method, L"POST") == 0;
      const wchar_t *hdr = L"Content-Type: application/json";
      if (WinHttpSendRequest(r, post ? hdr : WINHTTP_NO_ADDITIONAL_HEADERS, post ? (DWORD)-1L : 0,
                             post ? "{}" : NULL, post ? 2 : 0, post ? 2 : 0, 0) &&
          WinHttpReceiveResponse(r, NULL)) {
        total = 0;
        DWORD got = 0;
        while (out && total < outLen - 1 && WinHttpReadData(r, out + total, outLen - 1 - total, &got) && got > 0) total += got;
        if (out) out[total] = 0;
      }
      WinHttpCloseHandle(r);
    }
    WinHttpCloseHandle(c);
  }
  WinHttpCloseHandle(s);
  return total;
}

static BOOL botIsRunning(void) {
  static char buf[65536];
  if (http(L"GET", L"/api/status", buf, sizeof(buf), 1500) <= 0) return FALSE;
  return strstr(buf, "\"botState\":\"running\"") || strstr(buf, "\"botState\":\"starting\"");
}

static DWORD WINAPI waitChild(LPVOID param) {
  HANDLE h = (HANDLE)param;
  WaitForSingleObject(h, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(h, &code);
  PostMessageW(g_hwnd, WM_CHILD_EXIT, (WPARAM)code, 0);
  return 0;
}

static BOOL startManager(void) {
  wchar_t node[MAX_PATH], cmd[MAX_PATH * 2], logDir[MAX_PATH];
  swprintf(node, MAX_PATH, L"%ls\\runtime\\node.exe", g_base);
  swprintf(cmd, MAX_PATH * 2, L"\"%ls\" server.js", node);
  swprintf(logDir, MAX_PATH, L"%ls\\logs", g_appDir);
  CreateDirectoryW(logDir, NULL);

  SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
  HANDLE log = CreateFileW(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);

  SetEnvironmentVariableW(L"NT_LAUNCHER", L"1");
  SetEnvironmentVariableW(L"NT_RESTARTED", g_restarted ? L"1" : NULL);
  SetEnvironmentVariableW(L"FORCE_COLOR", L"0");

  STARTUPINFOW si = { sizeof(si) };
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = log;
  si.hStdError = log;
  PROCESS_INFORMATION pi;
  BOOL ok = CreateProcessW(node, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, g_appDir, &si, &pi);
  if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
  if (!ok) {
    wchar_t msg[512];
    swprintf(msg, 512, L"Could not start Note Tiger (error %lu).\nTry reinstalling it.", GetLastError());
    MessageBoxW(NULL, msg, L"Note Tiger", MB_ICONERROR);
    return FALSE;
  }
  CloseHandle(pi.hThread);
  g_child = pi.hProcess;
  CreateThread(NULL, 0, waitChild, pi.hProcess, 0, NULL);
  setTip(L"Note Tiger is running");
  return TRUE;
}

// Ask the manager to quit cleanly (it saves any recording first), then force it if needed.
static void stopManager(DWORD waitMs) {
  if (!g_child) return;
  http(L"POST", L"/api/stop", NULL, 0, 3000);
  if (WaitForSingleObject(g_child, waitMs) == WAIT_TIMEOUT) TerminateProcess(g_child, 0);
}

static void showMenu(void) {
  POINT pt;
  GetCursorPos(&pt);
  BOOL running = botIsRunning();
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING | MF_DEFAULT, ID_OPEN, L"Open Note Tiger");
  AppendMenuW(m, MF_STRING | (g_child ? 0 : MF_GRAYED), ID_BOT, running ? L"Stop bot" : L"Start bot");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, ID_LOGS, L"Open log file");
  AppendMenuW(m, MF_STRING, ID_FOLDER, L"Open data folder");
  AppendMenuW(m, MF_STRING, ID_RESTART, L"Restart Note Tiger");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, ID_QUIT, L"Quit Note Tiger");
  SetForegroundWindow(g_hwnd);
  TrackPopupMenu(m, TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_hwnd, NULL);
  DestroyMenu(m);
}

static LRESULT CALLBACK wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_TRAY:
      if (LOWORD(lp) == WM_LBUTTONDBLCLK || LOWORD(lp) == NIN_SELECT || LOWORD(lp) == NIN_KEYSELECT) openWindow();
      else if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) showMenu();
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case ID_OPEN: openWindow(); break;
        case ID_BOT:
          if (botIsRunning()) { setTip(L"Note Tiger: stopping the bot…"); http(L"POST", L"/api/bot/stop", NULL, 0, 60000); setTip(L"Note Tiger is running (bot stopped)"); }
          else { http(L"POST", L"/api/bot/start", NULL, 0, 3000); setTip(L"Note Tiger is running"); }
          break;
        case ID_LOGS: ShellExecuteW(NULL, L"open", g_logPath, NULL, NULL, SW_SHOWNORMAL); break;
        case ID_FOLDER: {
          wchar_t d[MAX_PATH];
          swprintf(d, MAX_PATH, L"%ls\\data", g_appDir);
          CreateDirectoryW(d, NULL);
          ShellExecuteW(NULL, L"open", d, NULL, NULL, SW_SHOWNORMAL);
          break;
        }
        case ID_RESTART:
          if (g_child) { g_restartRequested = TRUE; stopManager(60000); }
          else { g_restarted = TRUE; startManager(); }
          break;
        case ID_QUIT:
          g_quitting = TRUE;
          setTip(L"Note Tiger: stopping…");
          closeWindow();
          if (g_child) stopManager(60000); else DestroyWindow(h);
          break;
      }
      return 0;
    case WM_CHILD_EXIT: {
      DWORD code = (DWORD)wp;
      if (g_child) { CloseHandle(g_child); g_child = NULL; }
      if (g_quitting) { DestroyWindow(h); return 0; }
      if (code == RESTART_CODE || g_restartRequested) {
        g_restartRequested = FALSE;
        g_restarted = TRUE;
        readPort();
        startManager();
      } else if (code == 0) {
        closeWindow();
        DestroyWindow(h);
      } else if (code == PORT_BUSY_CODE) {
        closeWindow();
        MessageBoxW(NULL, L"Note Tiger couldn't start because another copy of the bot is already running.\n\n"
                          L"Close the old black \"start-bot.bat\" window (or any other Note Tiger), then start Note Tiger again.",
                    L"Note Tiger", MB_ICONWARNING);
        DestroyWindow(h);
      } else {
        // Unexpected crash: restart automatically, but not more than 3 times a minute.
        DWORD now = GetTickCount();
        int recent = 0;
        for (int i = 0; i < 3; i++) if (g_crashTimes[i] && now - g_crashTimes[i] < 60000) recent++;
        g_crashTimes[0] = g_crashTimes[1]; g_crashTimes[1] = g_crashTimes[2]; g_crashTimes[2] = now;
        if (recent < 3) {
          g_restarted = TRUE;
          startManager();
        } else {
          setTip(L"Note Tiger stopped (error)");
          balloon(L"Note Tiger stopped", L"It keeps crashing. Right-click the tiger icon → Open log file to see why.");
        }
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

  // Already running? Just open the window.
  CreateMutexW(NULL, TRUE, L"Local\\NoteTigerLauncher");
  if (GetLastError() == ERROR_ALREADY_EXISTS) { openWindow(); return 0; }

  WNDCLASSW wc = {0};
  wc.lpfnWndProc = wndProc;
  wc.hInstance = inst;
  wc.lpszClassName = L"NoteTigerTray";
  RegisterClassW(&wc);
  g_hwnd = CreateWindowW(wc.lpszClassName, L"Note Tiger tray", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, inst, NULL);

  g_nid.cbSize = sizeof(g_nid);
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  wcscpy(g_nid.szTip, L"Note Tiger: starting…");
  Shell_NotifyIconW(NIM_ADD, &g_nid);

  if (!startManager()) { Shell_NotifyIconW(NIM_DELETE, &g_nid); return 1; }
  openWindow();

  MSG m;
  while (GetMessageW(&m, NULL, 0, 0)) { TranslateMessage(&m); DispatchMessageW(&m); }
  return 0;
}
